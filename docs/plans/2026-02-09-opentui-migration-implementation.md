# OpenTUI Migration Implementation Plan

> **For Codex:** Execute this plan task-by-task. If an `executing-plans` skill is installed, use it; otherwise follow the steps manually.

**Goal:** Migrate the full terminal UI runtime from Ink to OpenTUI in a new repository while preserving behavior and keyboard interactions.

**Architecture:** Keep existing app/state/orchestrator modules intact and replace only the TUI runtime layer. Introduce a small `ink`-compat wrapper implemented on top of `@opentui/react` + `@opentui/core` so current JSX can be migrated safely, then remove all Ink dependencies and imports. Add migration guard tests that fail when Ink reappears.

**Tech Stack:** Bun, TypeScript, React, OpenTUI (`@opentui/core`, `@opentui/react`), existing Zustand application state.

**Files to Understand:**

Before starting, read and understand these files to get context:

- `src/index.tsx` - CLI entrypoint and Ink renderer bootstrap.
- `src/ui/app.tsx` - top-level TUI orchestration and global keyboard handling.
- `src/ui/widgets/chat-panel.tsx` - uses Ink markdown + spinner APIs that must be replaced.
- `src/ui/widgets/claude-chat.tsx` - additional spinner and input behavior to preserve.
- `src/ui/widgets/tmux-pane.tsx` - raw keyboard mapping behavior to preserve.
- `package.json` - dependencies/scripts that must be updated.
- `tsconfig.json` - JSX/runtime config for OpenTUI compatibility.

---

### Task 1: Add migration guard tests (RED first)

**Files:**

- Create: `src/ui/opentui-migration.test.ts`

**Step 1: Write the failing test**

Add tests that assert:
- No source file imports `ink`.
- `package.json` has no `ink`, `ink-spinner`, or `ink-markdown` dependencies.
- `src/index.tsx` uses OpenTUI renderer APIs.

**Step 2: Run test to verify it fails**

Run: `bun test src/ui/opentui-migration.test.ts`
Expected: FAIL because current code still imports Ink and dependencies still exist.

**Step 3: Keep tests as migration guard**

Do not weaken assertions; use them as completion criteria.

### Task 2: Replace runtime entrypoint with OpenTUI renderer

**Files:**

- Modify: `src/index.tsx`

**Step 1: Add/adjust tests if needed**

If entrypoint-specific assertions are missing from Task 1, add them first and run failing tests.

**Step 2: Implement minimal runtime migration**

Replace `ink.render(...)` with OpenTUI renderer bootstrapping:
- `createCliRenderer({ exitOnCtrlC: false })`
- `createRoot(renderer).render(<App ... />)`

Preserve existing init/help/tmux behavior.

**Step 3: Run focused tests**

Run: `bun test src/ui/opentui-migration.test.ts`
Expected: partial pass (entrypoint assertions pass; import/dependency assertions may still fail).

### Task 3: Implement Ink compatibility layer on OpenTUI

**Files:**

- Create: `src/ui/ink.tsx`

**Step 1: Write/expand failing tests first**

Add tests (or assertions) for API compatibility used by codebase:
- `useInput` key mapping for arrows/enter/escape/tab/backspace/delete.
- `Text` prop mapping for `color`, `backgroundColor`, `bold`, `dimColor`, `italic`, `underline`, `strikethrough`, `wrap`.
- `Box` prop mapping for `paddingX/Y`, `marginX/Y`, `overflowY`, `borderStyle="round"`.

**Step 2: Implement minimal compat API**

Export equivalents used in repo:
- `Box`, `Text`
- `useInput`, `useApp`, `useFocusManager`, `useStdout`

Use OpenTUI hooks/renderer primitives internally.

**Step 3: Run focused tests**

Run: `bun test src/ui/opentui-migration.test.ts`
Expected: compatibility assertions pass.

### Task 4: Migrate UI imports and replace Ink-only widgets

**Files:**

- Modify: `src/ui/app.tsx`
- Modify: `src/ui/hooks/use-raw-input.ts`
- Modify: `src/ui/screens/output.tsx`
- Modify: `src/ui/widgets/*.tsx` files currently importing `ink`

**Step 1: Write failing test/assertion first**

Add assertion that no `from "ink"` imports remain under `src/`.

**Step 2: Implement migration**

- Replace `from "ink"` imports with `from "./ink.tsx"` or `from "../ink.tsx"` as appropriate.
- Replace `ink-spinner` usage with a local lightweight spinner component (OpenTUI-compatible).
- Replace `@jescalan/ink-markdown` usage with OpenTUI markdown renderable or safe text fallback.

**Step 3: Run tests**

Run: `bun test src/ui/opentui-migration.test.ts`
Expected: pass for import migration checks.

### Task 5: Remove Ink dependencies and update config/docs

**Files:**

- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/UI_DESIGN.md` (if Ink-specific language exists)

**Step 1: Write failing dependency assertions first**

Ensure guard test fails while `ink*` deps are present.

**Step 2: Implement dependency/doc migration**

- Remove `ink`, `ink-spinner`, and `ink-markdown` dependencies.
- Add `@opentui/core`, `@opentui/react` dependencies.
- Update docs that describe Ink architecture to OpenTUI.

**Step 3: Run focused tests**

Run: `bun test src/ui/opentui-migration.test.ts`
Expected: all migration guard tests pass.

### Task 6: Full verification and regression checks

**Files:**

- No code changes required unless verification fails.

**Step 1: Run complete verification suite**

Run:
- `bun install`
- `bun test`
- `bun run typecheck`
- `bun run lint`

**Step 2: Run runtime smoke check**

Run:
- `bun run src/index.tsx --help`
- `timeout 5 bun run src/index.tsx` (or equivalent short run) to verify renderer bootstraps.

**Step 3: Fix any failures and re-run verification**

Repeat until clean.

### Task 7: Structured review before completion

**Files:**

- Review-only task

**Step 1: Perform self code review against requirements**

Validate:
- Original repo untouched.
- New repo fully migrated to OpenTUI.
- No remaining Ink imports/deps.
- Keyboard behavior parity maintained.
- Docs updated.

**Step 2: Report results with evidence**

Summarize commands run, exit codes, and any known residual risks.
