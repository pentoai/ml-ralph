/**
 * Docker sandbox: each iteration's claude process runs in a container that
 * mounts only the project directory. The runner (eval, holdout scoring, the
 * verifier, jobs) stays on the host; see sandbox-forward.ts for how
 * `ml-ralph log|eval|job` inside the container reach it.
 */

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHoldoutPath } from "./holdout.ts";

export type SandboxMode = "docker";

/** Bump when the Dockerfile or the shim changes, so a stale image is rebuilt */
export const SANDBOX_IMAGE = "ml-ralph-sandbox:1";
export const API_KEY_ENV = "ANTHROPIC_API_KEY";
/** Where the shim in the container finds the request directory */
export const SANDBOX_DIR_ENV = "ML_RALPH_SANDBOX_DIR";
export const CONTAINER_LABEL = "ml-ralph.sandbox";
const CONTEXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "sandbox");

export const buildCommand = (docker = "docker", image = SANDBOX_IMAGE) =>
  `${docker} build -t ${image} ${CONTEXT_DIR}`;

/** `sandbox` from .ml-ralph/config.json: "docker", or "none"/unset for host mode */
export async function readSandboxMode(
  projectPath: string,
): Promise<{ ok: true; mode?: SandboxMode } | { ok: false; error: string }> {
  let config: { sandbox?: unknown } | null;
  try {
    config = await Bun.file(join(projectPath, ".ml-ralph/config.json")).json();
  } catch {
    return { ok: true };
  }
  const value = config?.sandbox;
  if (value === undefined || value === "none") return { ok: true };
  if (value === "docker") return { ok: true, mode: "docker" };
  return {
    ok: false,
    error: `config.json: sandbox must be "docker" or "none", got ${JSON.stringify(value)}`,
  };
}

interface DockerResult {
  code: number;
  out: string;
  err: string;
}

async function runDocker(
  docker: string,
  args: string[],
  inherit = false,
): Promise<DockerResult> {
  try {
    const proc = Bun.spawn([docker, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (inherit) process.stderr.write(err);
    return { code, out, err };
  } catch (error) {
    return {
      code: 127,
      out: "",
      err: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SandboxCheckOptions {
  projectPath: string;
  docker?: string;
  env?: Record<string, string | undefined>;
  /** Build a missing image (default) instead of refusing with the command */
  buildImage?: boolean;
  /** Progress lines while the image builds */
  onStatus?: (line: string) => void;
}

/**
 * Refuse to start a sandboxed run unless it can be isolated: an API key to
 * pass in, a working Docker, a holdout outside the project, and the image.
 */
export async function checkSandbox(
  options: SandboxCheckOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const docker = options.docker ?? "docker";
  const env = options.env ?? process.env;
  const refuse = (error: string) => ({
    ok: false as const,
    error: `Sandbox docker: ${error}`,
  });

  if (!env[API_KEY_ENV]) {
    return refuse(
      `${API_KEY_ENV} is not set. The container has no access to the claude login on this machine, so it authenticates with an API key; export ${API_KEY_ENV} or run without --sandbox.`,
    );
  }

  const info = await runDocker(docker, [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  if (info.code !== 0) {
    return refuse(
      `Docker is unavailable (\`${docker} info\` failed: ${info.err.trim().split("\n")[0] || `exit ${info.code}`}). Start Docker or run without --sandbox.`,
    );
  }

  const holdout = await readHoldoutPath(options.projectPath, env);
  if (!holdout.ok && holdout.insideProject) {
    return refuse(
      `the holdout path is inside the project directory, which the container mounts. ${holdout.error}`,
    );
  }

  const image = await runDocker(docker, ["image", "inspect", SANDBOX_IMAGE]);
  if (image.code !== 0) {
    if (options.buildImage === false) {
      return refuse(
        `image ${SANDBOX_IMAGE} is missing. Build it with: ${buildCommand(docker)}`,
      );
    }
    options.onStatus?.(`Building ${SANDBOX_IMAGE} (first run only)...`);
    const build = await runDocker(docker, [
      "build",
      "-t",
      SANDBOX_IMAGE,
      CONTEXT_DIR,
    ]);
    if (build.code !== 0) {
      return refuse(
        `building image ${SANDBOX_IMAGE} failed: ${build.err.trim().split("\n").slice(-3).join(" | ")}. Build it by hand with: ${buildCommand(docker)}`,
      );
    }
  }
  return { ok: true };
}

/** What runs in a container: the agent, a job it started or an eval of its candidate */
export type ContainerKind = "agent" | "job" | "eval" | "holdout";

export interface ContainerSpec {
  /** The project directory, mounted at the same absolute path inside */
  projectPath: string;
  name: string;
  /** Variables the container receives; nothing else of the host environment reaches it */
  env: Record<string, string>;
  uid?: number;
  gid?: number;
  image?: string;
  kind?: ContainerKind;
  /** Working directory inside (default: the project directory) */
  cwd?: string;
  /** Pass ANTHROPIC_API_KEY by name, so it is not in the process list (agent only) */
  apiKey?: boolean;
  /** Extra read-only mounts (the eval's private copy of evaluate.py, the sealed holdout) */
  readOnlyMounts?: string[];
  /** Mount the project read-only too, so nothing can be written back (holdout scoring) */
  projectReadOnly?: boolean;
  /** No network and a read-only root filesystem, with scratch tmpfs at /tmp and HOME (holdout scoring) */
  isolated?: boolean;
}

/**
 * `docker run` arguments for one container. The only writable mount is the
 * project directory; HOME is a tmpfs, so ~/.config/ml-ralph and the host login
 * are absent. Jobs and evals get the same mounts and hardening as the agent.
 */
export function containerArgs(
  spec: ContainerSpec,
  command: string[],
): string[] {
  const owner =
    spec.uid !== undefined && spec.gid !== undefined
      ? [`--user`, `${spec.uid}:${spec.gid}`]
      : [];
  const tmpfsOwner =
    spec.uid !== undefined && spec.gid !== undefined
      ? `,uid=${spec.uid},gid=${spec.gid}`
      : ",mode=1777";
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    spec.name,
    "--label",
    `${CONTAINER_LABEL}=${spec.kind ?? "agent"}`,
    "--label",
    `${CONTAINER_LABEL}.project=${spec.projectPath}`,
    ...owner,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // A read-only root still gets a scratch /tmp, as the search-eval containers have, so tempfile works
    ...(spec.isolated
      ? [
          "--network",
          "none",
          "--read-only",
          "--tmpfs",
          `/tmp:rw,exec${tmpfsOwner}`,
        ]
      : []),
    "--tmpfs",
    `/home/agent:rw,exec${tmpfsOwner}`,
    "-v",
    `${spec.projectPath}:${spec.projectPath}${spec.projectReadOnly ? ":ro" : ""}`,
    ...(spec.readOnlyMounts ?? []).flatMap((m) => ["-v", `${m}:${m}:ro`]),
    "-w",
    spec.cwd ?? spec.projectPath,
    "-e",
    "HOME=/home/agent",
    ...(spec.apiKey === false ? [] : ["-e", API_KEY_ENV]),
    ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    spec.image ?? SANDBOX_IMAGE,
    ...command,
  ];
}

export interface WrappedCommand {
  argv: string[];
  /** The container's name, for removal when the process is killed from outside */
  container: string;
  /** Force-remove the container; call when the process was killed or timed out */
  remove: () => void;
}

/** Wraps a command so it runs in a sibling container instead of on the host */
export type CommandWrapper = (
  argv: string[],
  options: {
    /** "holdout" mounts the project read-only, adds no network and a read-only root */
    kind: "job" | "eval" | "holdout";
    cwd?: string;
    env?: Record<string, string>;
    readOnlyMounts?: string[];
  },
) => WrappedCommand;

/** A wrapper for `projectPath` (already resolved) that never forwards the host environment */
export function commandWrapper(
  docker: string,
  projectPath: string,
): CommandWrapper {
  return (argv, options) => {
    const container = containerName();
    return {
      container,
      remove: () => removeContainer(docker, container),
      argv: [
        docker,
        ...containerArgs(
          {
            projectPath,
            name: container,
            kind: options.kind,
            cwd: options.cwd,
            env: options.env ?? {},
            apiKey: false,
            readOnlyMounts: options.readOnlyMounts,
            projectReadOnly: options.kind === "holdout",
            isolated: options.kind === "holdout",
            uid: process.getuid?.(),
            gid: process.getgid?.(),
          },
          argv,
        ),
      ],
    };
  };
}

export const containerName = () => `ml-ralph-${randomBytes(5).toString("hex")}`;

/** The project directory with symlinks resolved: the path mounted, and the cwd inside */
export async function sandboxProjectPath(projectPath: string): Promise<string> {
  return realpath(projectPath);
}

/** Git needs an identity to commit inside the container; reuse the host's, or a neutral one */
export function gitIdentityEnv(
  read: (key: string) => string = hostGitConfig,
): Record<string, string> {
  const name = read("user.name") || "ml-ralph agent";
  const email = read("user.email") || "ml-ralph@localhost";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
  };
}

function hostGitConfig(key: string): string {
  try {
    const proc = Bun.spawnSync(["git", "config", "--get", key], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return proc.stdout.toString().trim();
  } catch {
    return "";
  }
}

/** Force-remove a container; synchronous so it also works from a process `exit` hook */
export function removeContainer(docker: string, name: string): void {
  try {
    Bun.spawnSync([docker, "rm", "-f", name], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // docker is gone; nothing left to remove
  }
}

/** Remove agent, eval and holdout containers a crashed earlier run of this project left behind (job containers are tracked by their job record) */
export function removeStaleContainers(
  docker: string,
  projectPath: string,
): void {
  for (const kind of ["agent", "eval", "holdout"] as const) {
    try {
      const list = Bun.spawnSync(
        [
          docker,
          "ps",
          "-aq",
          "--filter",
          `label=${CONTAINER_LABEL}=${kind}`,
          "--filter",
          `label=${CONTAINER_LABEL}.project=${projectPath}`,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      for (const id of list.stdout.toString().split("\n").filter(Boolean)) {
        removeContainer(docker, id);
      }
    } catch {
      // docker is gone
    }
  }
}
