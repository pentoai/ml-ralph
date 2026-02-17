/**
 * Experiments panel - hypothesis-grouped view with consistent per-experiment layout
 */

import * as asciichart from "asciichart";
import { useEffect } from "react";
import { useAppStore } from "../../application/state/index.ts";
import type {
  ExperimentEvent,
  HypothesisWithStatus,
} from "../../infrastructure/ralph/index.ts";
import { Box, Text } from "../ink.tsx";
import { colors } from "../theme/colors.ts";

// --- Types ---

interface ExperimentsPanelProps {
  hypotheses: HypothesisWithStatus[];
  experiments: ExperimentEvent[];
  successCriteria: string[];
  selectedId: string | null;
  expandedId: string | null;
  offset?: number;
  limit?: number;
}

interface ParsedTarget {
  metricPattern: string;
  operator: ">" | ">=" | "<" | "<=" | "=";
  value: number;
}

interface ExperimentGroup {
  hypothesisId: string;
  hypothesisText: string;
  status: string;
  experiments: ExperimentEvent[];
}

// --- Helpers ---

function experimentId(exp: ExperimentEvent): string {
  return `${exp.name}::${exp.hypothesis_id}::${exp.ts}`;
}

function parseSuccessCriteria(criteria: string[]): ParsedTarget[] {
  const targets: ParsedTarget[] = [];
  for (const c of criteria) {
    const match = c.match(/(\w[\w\s]*?)\s*(>=|<=|>|<|=)\s*([\d.]+)/i);
    if (match && match[1] && match[2] && match[3]) {
      targets.push({
        metricPattern: match[1].trim().toLowerCase(),
        operator: match[2] as ParsedTarget["operator"],
        value: parseFloat(match[3]),
      });
    }
  }
  return targets;
}

function meetsTarget(value: number, target: ParsedTarget): boolean {
  switch (target.operator) {
    case ">":
      return value > target.value;
    case ">=":
      return value >= target.value;
    case "<":
      return value < target.value;
    case "<=":
      return value <= target.value;
    case "=":
      return Math.abs(value - target.value) < 0.001;
  }
}

function findTarget(
  metricKey: string,
  targets: ParsedTarget[],
): ParsedTarget | null {
  const lower = metricKey.toLowerCase().replace(/_/g, " ");
  for (const t of targets) {
    const pattern = t.metricPattern.replace(/_/g, " ");
    if (lower.includes(pattern) || pattern.includes(lower)) return t;
  }
  const abbrevMap: Record<string, string[]> = {
    auc: ["auc", "auc roc", "auc_roc"],
    acc: ["accuracy", "acc"],
    f1: ["f1", "f1 score", "f1_score"],
    loss: ["loss"],
    recall: ["recall"],
    precision: ["precision"],
  };
  for (const t of targets) {
    for (const [short, variants] of Object.entries(abbrevMap)) {
      if (
        variants.some((v) => t.metricPattern.includes(v)) &&
        lower.includes(short)
      )
        return t;
    }
  }
  return null;
}

const LOWER_BETTER_PATTERNS = [
  "loss",
  "error",
  "mse",
  "rmse",
  "mae",
  "time",
  "latency",
  "fpr",
];

function isLowerBetter(metricKey: string): boolean {
  const lower = metricKey.toLowerCase();
  return LOWER_BETTER_PATTERNS.some((p) => lower.includes(p));
}

function computeDelta(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function formatNumber(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 0.001) return value.toExponential(1);
  if (abs < 1) return value.toFixed(2);
  if (abs < 1000) return value.toFixed(abs < 10 ? 2 : 0);
  if (abs < 1000000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

function shortenKey(key: string): string {
  const abbrevs: Record<string, string> = {
    accuracy: "acc",
    precision: "prec",
    recall: "rec",
    inference_time: "inf",
    training_time: "train",
    samples: "n",
    auc_roc: "auc",
    recall_at_5pct_fpr: "r@5%",
    f1_score: "f1",
  };
  const lower = key.toLowerCase();
  for (const [full, short] of Object.entries(abbrevs)) {
    if (lower.includes(full)) return short;
  }
  const parts = key.split("_");
  return (parts[parts.length - 1] ?? key).slice(0, 6);
}

function getKeyMetric(
  metrics: Record<string, number>,
): { key: string; value: number } | null {
  const priority = [
    "auc_roc",
    "auc",
    "f1",
    "accuracy",
    "loss",
    "recall",
    "precision",
  ];
  for (const key of priority) {
    const found = Object.entries(metrics).find(([k]) =>
      k.toLowerCase().includes(key),
    );
    if (found) return { key: found[0], value: found[1] };
  }
  const first = Object.entries(metrics)[0];
  return first ? { key: first[0], value: first[1] } : null;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// --- Grouping ---

const statusConfig: Record<
  string,
  { color: string; icon: string; label: string }
> = {
  pending: { color: colors.accentYellow, icon: "○", label: "PENDING" },
  keep: { color: colors.accentGreen, icon: "✓", label: "KEPT" },
  reject: { color: colors.accentRed, icon: "✗", label: "REJECTED" },
  iterate: { color: colors.accentBlue, icon: "↻", label: "ITERATING" },
  pivot: { color: colors.accentPurple, icon: "⟳", label: "PIVOTED" },
};

function buildGroups(
  hypotheses: HypothesisWithStatus[],
  experiments: ExperimentEvent[],
): ExperimentGroup[] {
  const groups: ExperimentGroup[] = [];
  const usedExpIds = new Set<string>();

  for (const h of hypotheses) {
    const hExps = experiments
      .filter((e) => e.hypothesis_id === h.id)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    if (hExps.length === 0) continue;
    for (const e of hExps) usedExpIds.add(experimentId(e));
    groups.push({
      hypothesisId: h.id,
      hypothesisText: h.hypothesis,
      status: h.status,
      experiments: hExps,
    });
  }

  const ungrouped = experiments
    .filter((e) => !usedExpIds.has(experimentId(e)))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  if (ungrouped.length > 0) {
    groups.push({
      hypothesisId: "",
      hypothesisText: "Ungrouped",
      status: "",
      experiments: ungrouped,
    });
  }

  return groups;
}

function flattenGroupIds(groups: ExperimentGroup[]): string[] {
  const ids: string[] = [];
  for (const g of groups) {
    for (const e of g.experiments) ids.push(experimentId(e));
  }
  return ids;
}

// --- Components ---

/**
 * Summary line above the separator.
 */
function SummaryHeader({
  experiments,
  targets,
}: {
  experiments: ExperimentEvent[];
  targets: ParsedTarget[];
}) {
  const totalExps = experiments.length;
  const totalHyps = new Set(
    experiments.map((e) => e.hypothesis_id).filter(Boolean),
  ).size;

  let bestKey = "";
  let bestVal = -Infinity;
  let bestName = "";
  for (const exp of experiments) {
    const km = getKeyMetric(exp.metrics ?? {});
    if (km) {
      const lb = isLowerBetter(km.key);
      const better = lb ? km.value < bestVal : km.value > bestVal;
      if (bestKey === "" || better) {
        bestKey = km.key;
        bestVal = km.value;
        bestName = exp.name || exp.hypothesis_id;
      }
    }
  }

  let targetMet: boolean | null = null;
  let targetStr = "";
  if (bestKey && targets.length > 0) {
    const t = findTarget(bestKey, targets);
    if (t) {
      targetMet = meetsTarget(bestVal, t);
      targetStr = `${t.metricPattern.toUpperCase()} ${t.operator} ${t.value}`;
    }
  }

  return (
    <Box marginBottom={1}>
      <Text color={colors.textMuted}>
        {totalExps} experiment{totalExps !== 1 ? "s" : ""}
        {" · "}
        {totalHyps} hypothes{totalHyps !== 1 ? "es" : "is"}
      </Text>
      {bestKey && (
        <Text color={colors.textSecondary}>
          {"   best: "}
          <Text color={colors.accentGreen} bold>
            {shortenKey(bestKey)} {formatNumber(bestVal)}
          </Text>
          <Text color={colors.textMuted}> ({bestName.slice(0, 20)})</Text>
        </Text>
      )}
      {targetStr && (
        <Text color={colors.textSecondary}>
          {"   target: "}
          <Text color={targetMet ? colors.accentGreen : colors.accentYellow}>
            {targetStr} {targetMet ? "✓" : "○"}
          </Text>
        </Text>
      )}
    </Box>
  );
}

/**
 * Hypothesis group divider.
 */
function GroupHeader({ group }: { group: ExperimentGroup }) {
  if (group.hypothesisId === "") {
    return (
      <Box marginTop={1}>
        <Text color={colors.textMuted} bold>
          {"─ Ungrouped "}
        </Text>
        <Text color={colors.textMuted}>{"─".repeat(40)}</Text>
      </Box>
    );
  }

  const sc = statusConfig[group.status];
  const text =
    group.hypothesisText.length > 40
      ? group.hypothesisText.slice(0, 40) + "..."
      : group.hypothesisText;

  return (
    <Box marginTop={1}>
      <Text color={colors.textMuted} bold>
        {"─ "}
      </Text>
      <Text color={colors.accentBlue} bold>
        {group.hypothesisId}
      </Text>
      <Text color={colors.textMuted}> · </Text>
      <Text color={colors.textSecondary}>{text}</Text>
      {sc && (
        <>
          <Text color={colors.textMuted}> {"─ "}</Text>
          <Text color={sc.color} bold>
            {sc.icon} {sc.label}
          </Text>
        </>
      )}
    </Box>
  );
}

// --- Row column widths (consistent across all experiments) ---
// | arrow(3) | name(24) | metric(14) | delta(10) | time(8) |
const COL_NAME = 24;
const COL_METRIC = 14;
const COL_DELTA = 10;

/**
 * Collapsed experiment row. Every row renders the same columns at the same
 * widths regardless of which optional data is present.
 *
 * Layout: [arrow] [name] [key_metric] [delta] [time]
 */
function ExperimentRow({
  experiment,
  isSelected,
  isExpanded,
  delta,
}: {
  experiment: ExperimentEvent;
  isSelected: boolean;
  isExpanded: boolean;
  delta: string;
}) {
  const timeAgo = formatRelativeTime(experiment.ts);
  const keyMetric = getKeyMetric(experiment.metrics ?? {});
  const arrow = isExpanded ? "▼" : isSelected ? "▶" : "▷";
  const displayName = experiment.name || experiment.hypothesis_id;

  // Delta arrow direction
  let deltaDisplay = "";
  if (delta && keyMetric) {
    const good = isLowerBetter(keyMetric.key)
      ? delta.startsWith("-")
      : delta.startsWith("+");
    deltaDisplay = `${good ? "▲" : "▼"}${delta}`;
  }

  return (
    <Box>
      {/* Arrow — always 3 chars */}
      <Text color={isSelected ? colors.accentBlue : colors.textMuted}>
        {"  "}
        {arrow}{" "}
      </Text>

      {/* Name — always COL_NAME wide */}
      <Box width={COL_NAME}>
        <Text
          color={isSelected ? colors.accentBlue : colors.text}
          bold={isSelected}
        >
          {displayName.slice(0, COL_NAME - 2)}
        </Text>
      </Box>

      {/* Key metric — always COL_METRIC wide */}
      <Box width={COL_METRIC}>
        {keyMetric ? (
          <Text color={colors.accentGreen} bold>
            {shortenKey(keyMetric.key)}: {formatNumber(keyMetric.value)}
          </Text>
        ) : (
          <Text color={colors.textMuted}>{"—"}</Text>
        )}
      </Box>

      {/* Delta — always COL_DELTA wide */}
      <Box width={COL_DELTA}>
        {deltaDisplay ? (
          <Text
            color={
              deltaDisplay.startsWith("▲")
                ? colors.accentGreen
                : colors.accentRed
            }
          >
            {deltaDisplay}
          </Text>
        ) : (
          <Text color={colors.textMuted}> </Text>
        )}
      </Box>

      {/* Time — always present */}
      <Text color={colors.textSecondary}>{timeAgo}</Text>
    </Box>
  );
}

/**
 * Direction-aware metric bar for expanded details.
 */
function DirectionAwareMetricBar({
  value,
  max,
  lowerBetter,
  width = 12,
}: {
  value: number;
  max: number;
  lowerBetter: boolean;
  width?: number;
}) {
  const ratio = max > 0 ? Math.min(Math.abs(value) / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  if (lowerBetter) {
    return (
      <Text>
        <Text color={colors.bgTertiary}>{"░".repeat(empty)}</Text>
        <Text color={colors.accentRed}>{"█".repeat(filled)}</Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color={colors.accentGreen}>{"█".repeat(filled)}</Text>
      <Text color={colors.bgTertiary}>{"░".repeat(empty)}</Text>
    </Text>
  );
}

// --- Expanded detail column widths ---
const DETAIL_COL_KEY = 18;
const DETAIL_COL_BAR = 14;
const DETAIL_COL_VAL = 8;
const DETAIL_COL_DELTA = 10;

/**
 * Single metric row inside expanded details. Every metric renders the same
 * columns: [name] [bar] [value] [delta] [target].
 */
function MetricRow({
  metricKey,
  value,
  prevValue,
  targets,
}: {
  metricKey: string;
  value: number;
  prevValue: number | null;
  targets: ParsedTarget[];
}) {
  const lowerBetter = isLowerBetter(metricKey);
  const isNormalized = value >= 0 && value <= 1;
  const barMax = isNormalized ? 1 : Math.abs(value) * 1.2;
  const target = findTarget(metricKey, targets);

  const delta = prevValue !== null ? computeDelta(value, prevValue) : "";
  const deltaGood = delta
    ? lowerBetter
      ? delta.startsWith("-")
      : delta.startsWith("+")
    : null;

  return (
    <Box>
      <Box width={DETAIL_COL_KEY}>
        <Text color={colors.textSecondary}>
          {metricKey.slice(0, DETAIL_COL_KEY - 2)}
        </Text>
      </Box>
      <Box width={DETAIL_COL_BAR}>
        <DirectionAwareMetricBar
          value={value}
          max={barMax}
          lowerBetter={lowerBetter}
        />
      </Box>
      <Box width={DETAIL_COL_VAL}>
        <Text color={colors.accentGreen}>{formatNumber(value)}</Text>
      </Box>
      <Box width={DETAIL_COL_DELTA}>
        {delta ? (
          <Text color={deltaGood ? colors.accentGreen : colors.accentRed}>
            {delta}
          </Text>
        ) : (
          <Text color={colors.textMuted}>{"—"}</Text>
        )}
      </Box>
      {target ? (
        <Text
          color={
            meetsTarget(value, target)
              ? colors.accentGreen
              : colors.accentYellow
          }
        >
          {target.operator}
          {target.value} {meetsTarget(value, target) ? "✓" : "○"}
        </Text>
      ) : (
        <Text color={colors.textMuted}> </Text>
      )}
    </Box>
  );
}

/**
 * Sparkline of a single metric across experiments in the same hypothesis.
 * Only rendered when there are 3+ data points — this is the one section
 * that legitimately has nothing to show for small groups.
 */
function HypothesisSparkline({
  experiments,
}: {
  experiments: ExperimentEvent[];
}) {
  if (experiments.length < 3) return null;

  const keyMetricKey = (() => {
    for (const exp of experiments) {
      const km = getKeyMetric(exp.metrics ?? {});
      if (km) return km.key;
    }
    return null;
  })();
  if (!keyMetricKey) return null;

  const chronological = [...experiments].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );
  const values = chronological
    .map((e) => (e.metrics ?? {})[keyMetricKey])
    .filter((v): v is number => v !== undefined);
  if (values.length < 3) return null;

  try {
    const chart = asciichart.plot(values, {
      height: 3,
      format: (x: number) => x.toFixed(2),
    });
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.textMuted} bold>
          {shortenKey(keyMetricKey)} trend ({values.length} experiments):
        </Text>
        <Text color={colors.accentBlue}>{chart}</Text>
      </Box>
    );
  } catch {
    return null;
  }
}

/**
 * Expanded experiment details. Every experiment renders the same sections
 * in the same order. Optional fields show "—" when absent.
 *
 * Sections (always in this order):
 *   1. Name + hypothesis_id
 *   2. Config
 *   3. Metrics (with bars, deltas, targets)
 *   4. Sparkline (only if 3+ in group — acceptable omission)
 *   5. Observations
 *   6. Surprises
 *   7. wandb
 */
function ExperimentDetails({
  experiment,
  prevExperiment,
  groupExperiments,
  targets,
}: {
  experiment: ExperimentEvent;
  prevExperiment: ExperimentEvent | null;
  groupExperiments: ExperimentEvent[];
  targets: ParsedTarget[];
}) {
  const metrics = Object.entries(experiment.metrics ?? {});
  const prevMetrics = prevExperiment?.metrics ?? {};
  const config = experiment.config;
  const configEntries = config ? Object.entries(config) : [];

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.accentBlue}
      paddingX={2}
      paddingY={1}
      marginLeft={3}
      marginBottom={1}
    >
      {/* 1. Header — always: name + hypothesis */}
      <Box marginBottom={1}>
        <Text color={colors.accentBlue} bold>
          {experiment.name || experiment.hypothesis_id}
        </Text>
        <Text color={colors.textMuted}> ({experiment.hypothesis_id})</Text>
      </Box>

      {/* 2. Config — always present as section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.textMuted} bold>
          Config:
        </Text>
        {configEntries.length > 0 ? (
          <Text color={colors.textSecondary}>
            {configEntries.map(([k, v]) => `${k}=${String(v)}`).join(", ")}
          </Text>
        ) : (
          <Text color={colors.textMuted}>{"—"}</Text>
        )}
      </Box>

      {/* 3. Metrics — always present as section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.textMuted} bold>
          Metrics:
        </Text>
        {metrics.length > 0 ? (
          metrics.map(([key, value]) => (
            <MetricRow
              key={key}
              metricKey={key}
              value={value}
              prevValue={prevMetrics[key] ?? null}
              targets={targets}
            />
          ))
        ) : (
          <Text color={colors.textMuted}>{"—"}</Text>
        )}
      </Box>

      {/* 4. Sparkline — only when meaningful (3+ data points) */}
      <HypothesisSparkline experiments={groupExperiments} />

      {/* 5. Observations — always present as section */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.textMuted} bold>
          Observations:
        </Text>
        <Text color={experiment.observations ? colors.text : colors.textMuted}>
          {experiment.observations || "—"}
        </Text>
      </Box>

      {/* 6. Surprises — always present as section */}
      <Box flexDirection="column" marginTop={1}>
        <Text
          color={experiment.surprises ? colors.accentYellow : colors.textMuted}
          bold
        >
          Surprises:
        </Text>
        <Text color={experiment.surprises ? colors.text : colors.textMuted}>
          {experiment.surprises || "—"}
        </Text>
      </Box>

      {/* 7. wandb — always present as section */}
      <Box marginTop={1}>
        <Text color={colors.textMuted}>wandb: </Text>
        {experiment.wandb_url ? (
          <Text color={colors.accentCyan}>{experiment.wandb_url}</Text>
        ) : (
          <Text color={colors.textMuted}>{"—"}</Text>
        )}
      </Box>
    </Box>
  );
}

// --- Main panel ---

export function ExperimentsPanel({
  hypotheses,
  experiments,
  successCriteria,
  selectedId,
  expandedId,
  offset = 0,
  limit = 5,
}: ExperimentsPanelProps) {
  const setExperimentFlatList = useAppStore((s) => s.setExperimentFlatList);
  const setSelectedExperimentId = useAppStore((s) => s.setSelectedExperimentId);

  const groups = buildGroups(hypotheses, experiments);
  const flatIds = flattenGroupIds(groups);
  const targets = parseSuccessCriteria(successCriteria);

  // Sync flat list to store for keyboard navigation
  useEffect(() => {
    setExperimentFlatList(flatIds);
    if (!selectedId && flatIds.length > 0) {
      setSelectedExperimentId(flatIds[0] ?? null);
    }
  }, [flatIds.join(",")]);

  if (experiments.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box marginBottom={1}>
          <Text color={colors.accentYellow}>{"◇ "}</Text>
          <Text color={colors.text}>No experiments yet</Text>
        </Box>
        <Text color={colors.textSecondary}>
          Experiments are logged when the agent runs model training or
          evaluation.
        </Text>
        <Box marginTop={1}>
          <Text color={colors.textMuted}>
            Start the agent to begin running experiments.
          </Text>
        </Box>
      </Box>
    );
  }

  // Auto-scroll to keep selection visible
  const selectedFlatIndex = selectedId ? flatIds.indexOf(selectedId) : 0;
  let autoOffset = offset;
  if (selectedFlatIndex >= 0) {
    if (selectedFlatIndex < autoOffset) autoOffset = selectedFlatIndex;
    else if (selectedFlatIndex >= autoOffset + limit)
      autoOffset = selectedFlatIndex - limit + 1;
  }

  const total = flatIds.length;
  const safeOffset = Math.max(
    0,
    Math.min(autoOffset, Math.max(0, total - limit)),
  );
  const visibleExpIds = new Set(flatIds.slice(safeOffset, safeOffset + limit));

  const visibleGroups = new Set<string>();
  for (const group of groups) {
    for (const exp of group.experiments) {
      if (visibleExpIds.has(experimentId(exp))) {
        visibleGroups.add(group.hypothesisId + group.hypothesisText);
      }
    }
  }

  const hasMore = safeOffset + limit < total;
  const hasPrev = safeOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <SummaryHeader experiments={experiments} targets={targets} />
      <Text color={colors.textMuted}>{"─".repeat(70)}</Text>

      {groups.map((group) => {
        const groupKey = group.hypothesisId + group.hypothesisText;
        if (!visibleGroups.has(groupKey)) return null;

        return (
          <Box key={groupKey} flexDirection="column">
            <GroupHeader group={group} />
            {group.experiments.map((exp, i) => {
              const id = experimentId(exp);
              if (!visibleExpIds.has(id)) return null;

              const isSelected = selectedId === id;
              const isExpanded = expandedId === id;
              const prevExp =
                i < group.experiments.length - 1
                  ? (group.experiments[i + 1] ?? null)
                  : null;
              const keyMetric = getKeyMetric(exp.metrics ?? {});
              const prevKeyMetric = prevExp
                ? getKeyMetric(prevExp.metrics ?? {})
                : null;

              let delta = "";
              if (
                keyMetric &&
                prevKeyMetric &&
                keyMetric.key === prevKeyMetric.key
              ) {
                delta = computeDelta(keyMetric.value, prevKeyMetric.value);
              }

              return (
                <Box key={id} flexDirection="column">
                  <ExperimentRow
                    experiment={exp}
                    isSelected={isSelected}
                    isExpanded={isExpanded}
                    delta={delta}
                  />
                  {isExpanded && (
                    <ExperimentDetails
                      experiment={exp}
                      prevExperiment={prevExp}
                      groupExperiments={group.experiments}
                      targets={targets}
                    />
                  )}
                </Box>
              );
            })}
          </Box>
        );
      })}

      {(hasPrev || hasMore) && (
        <Box marginTop={1}>
          <Text color={colors.textMuted}>
            Showing {safeOffset + 1}-{Math.min(safeOffset + limit, total)} of{" "}
            {total}
          </Text>
          <Text color={colors.textSecondary}>
            {" "}
            (j/k navigate, Enter expand)
          </Text>
        </Box>
      )}
    </Box>
  );
}
