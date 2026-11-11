/**
 * Tests for the Docker sandbox: container arguments, the start-up checks, the
 * request-file bridge and the runner's use of docker (a stub `docker`; the one
 * test that needs a real daemon is skipped, with a logged reason, without one)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockEvalContract } from "./eval-lock.ts";
import { scoreHoldout } from "./holdout.ts";
import { readActiveJobs, stopJob } from "./jobs.ts";
import { RalphRunner, type RunCompleteReason } from "./runner.ts";
import {
  API_KEY_ENV,
  buildCommand,
  type CommandWrapper,
  checkSandbox,
  commandWrapper,
  containerArgs,
  readSandboxMode,
  SANDBOX_IMAGE,
} from "./sandbox.ts";
import { executeRequest, startForwarder } from "./sandbox-forward.ts";

const spec = {
  projectPath: "/work/proj",
  name: "ml-ralph-abc",
  env: { ML_RALPH_ITERATION: "2" },
  uid: 1001,
  gid: 1002,
};

describe("containerArgs", () => {
  const args = containerArgs(spec, ["claude", "-p", "hi"]);
  const mounts = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));

  test("mounts only the project directory, at the same path", () => {
    expect(mounts).toEqual(["/work/proj:/work/proj"]);
    expect(args).not.toContain("--volumes-from");
    expect(args.join(" ")).not.toContain(".config");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  test("runs as the host user and removes the container", () => {
    expect(
      args.slice(args.indexOf("--user"), args.indexOf("--user") + 2),
    ).toEqual(["--user", "1001:1002"]);
    expect(args).toContain("--rm");
    expect(args).toContain("--init");
  });

  test("passes the API key by name, never by value", () => {
    const at = args.indexOf(API_KEY_ENV);
    expect(args[at - 1]).toBe("-e");
    expect(args.some((a) => a.startsWith(`${API_KEY_ENV}=`))).toBe(false);
  });

  test("ends with the image and the command", () => {
    expect(args.slice(-4)).toEqual([SANDBOX_IMAGE, "claude", "-p", "hi"]);
  });
});

describe("readSandboxMode", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-mode-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("host by default, docker from config.json, an error for anything else", async () => {
    expect(await readSandboxMode(dir)).toEqual({ ok: true });
    await Bun.write(join(dir, ".ml-ralph/config.json"), '{"sandbox":"docker"}');
    expect(await readSandboxMode(dir)).toEqual({ ok: true, mode: "docker" });
    await Bun.write(join(dir, ".ml-ralph/config.json"), '{"sandbox":"none"}');
    expect(await readSandboxMode(dir)).toEqual({ ok: true });
    await Bun.write(join(dir, ".ml-ralph/config.json"), '{"sandbox":"podman"}');
    const bad = await readSandboxMode(dir);
    expect(bad.ok).toBe(false);
  });
});

/**
 * What `docker run` does, minus the filesystem: only the -e variables exist in
 * the "container", and it starts in the -w directory
 */
const EMULATE_RUN = `shift; envs=""; w="."
    while [ $# -gt 0 ]; do case "$1" in
      -v|--name|--label|--user|--cap-drop|--security-opt|--tmpfs|--network) shift 2;;
      --rm|--init|--read-only) shift;;
      -w) w="$2"; shift 2;;
      -e) case "$2" in *=*) envs="$envs $2";; esac; shift 2;;
      *) break;; esac; done
    shift
    cd "$w" && exec env -i PATH="$PATH" $envs "$@"`;

/** A `docker` that records its calls; `info` and `image inspect` succeed unless the test says otherwise */
async function stubDocker(
  dir: string,
  opts: { info?: boolean; image?: boolean; run?: string } = {},
) {
  const path = join(dir, "docker");
  await Bun.write(
    path,
    `#!/bin/sh
d="$(dirname "$0")"
echo "$*" >> "$d/calls"
case "$1" in
  info) ${opts.info === false ? "echo 'Cannot connect to the Docker daemon' >&2; exit 1" : "exit 0"} ;;
  image) ${opts.image === false && "true" ? 'test -e "$d/built"; exit $?' : "exit 0"} ;;
  build) touch "$d/built"; exit 0 ;;
  ps) exit 0 ;;
  rm) exit 0 ;;
  run) ${opts.run === "emulate" ? EMULATE_RUN : (opts.run ?? "exit 0")} ;;
esac
`,
  );
  await chmod(path, 0o755);
  return path;
}

const calls = async (dir: string) =>
  (
    await Bun.file(join(dir, "calls"))
      .text()
      .catch(() => "")
  )
    .trim()
    .split("\n")
    .filter(Boolean);

describe("checkSandbox", () => {
  let dir: string;
  let stub: string;
  let sealed: string;
  let configHome: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-proj-"));
    stub = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-stub-"));
    sealed = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-sealed-"));
    configHome = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-cfg-"));
  });
  afterEach(() =>
    Promise.all(
      [dir, stub, sealed, configHome].map((d) =>
        rm(d, { recursive: true, force: true }),
      ),
    ),
  );

  const env = () => ({ [API_KEY_ENV]: "sk-test", XDG_CONFIG_HOME: configHome });
  const setHolidayConfig = async (holdout: string) => {
    await mkdir(join(configHome, "ml-ralph"), { recursive: true });
    await Bun.write(
      join(configHome, "ml-ralph/config.json"),
      JSON.stringify({ projects: { [dir]: { holdout_path: holdout } } }),
    );
  };

  test("passes with an API key, a working docker and the image", async () => {
    const docker = await stubDocker(stub);
    expect(
      await checkSandbox({ projectPath: dir, docker, env: env() }),
    ).toEqual({ ok: true });
  });

  test("refuses without ANTHROPIC_API_KEY, naming it", async () => {
    const docker = await stubDocker(stub);
    const result = await checkSandbox({ projectPath: dir, docker, env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain("ANTHROPIC_API_KEY is not set");
  });

  test("refuses when docker is not installed or its daemon is down", async () => {
    const missing = await checkSandbox({
      projectPath: dir,
      docker: join(stub, "no-such-docker"),
      env: env(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("Docker is unavailable");

    const docker = await stubDocker(stub, { info: false });
    const down = await checkSandbox({ projectPath: dir, docker, env: env() });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error).toContain("Docker is unavailable");
  });

  test("refuses when the holdout path is inside the project directory", async () => {
    const docker = await stubDocker(stub);
    await mkdir(join(dir, "holdout"));
    await setHolidayConfig(join(dir, "holdout"));
    const result = await checkSandbox({ projectPath: dir, docker, env: env() });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain(
        "holdout path is inside the project directory",
      );
  });

  test("a holdout outside the project, or none, is accepted", async () => {
    const docker = await stubDocker(stub);
    await setHolidayConfig(sealed);
    expect(
      (await checkSandbox({ projectPath: dir, docker, env: env() })).ok,
    ).toBe(true);
  });

  test("a missing image is built, or refused with the build command", async () => {
    const docker = await stubDocker(stub, { image: false });
    const refused = await checkSandbox({
      projectPath: dir,
      docker,
      env: env(),
      buildImage: false,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(buildCommand(docker));

    expect(
      (await checkSandbox({ projectPath: dir, docker, env: env() })).ok,
    ).toBe(true);
    expect(
      (await calls(stub)).some((c) =>
        c.startsWith(`build -t ${SANDBOX_IMAGE}`),
      ),
    ).toBe(true);
  });

  test("the Dockerfile ships with the claude CLI, Python and the forwarding shim", async () => {
    const dockerfile = await Bun.file(
      new URL("./sandbox/Dockerfile", import.meta.url),
    ).text();
    expect(dockerfile).toContain("@anthropic-ai/claude-code");
    expect(dockerfile).toContain("python3");
    expect(dockerfile).toContain("ml-ralph-forward.py");
  });
});

describe("request forwarding", () => {
  let dir: string;
  let stub: string;
  let wrap: CommandWrapper;
  const forward = (
    request: unknown,
    env: Record<string, string | undefined> = {},
  ) => executeRequest(request, dir, env, wrap);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-fwd-"));
    stub = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-fwd-stub-"));
    wrap = commandWrapper(await stubDocker(stub, { run: "emulate" }), dir);
    await mkdir(join(dir, ".ml-ralph/eval"), { recursive: true });
    await Bun.write(
      join(dir, ".ml-ralph/prd.json"),
      JSON.stringify({ project: "p", status: "approved" }),
    );
    await Bun.write(
      join(dir, ".ml-ralph/eval/contract.json"),
      JSON.stringify({
        primary_metric: "auc",
        direction: "max",
        search_split: "cv",
        seeds: [0, 1],
        protocol: "cv",
        success_threshold: 0.9,
        holdout_gap_threshold: 0.02,
        eval_timeout_seconds: 30,
        baseline_score: 0.5,
      }),
    );
    await Bun.write(
      join(dir, ".ml-ralph/eval/evaluate.py"),
      'import json\nprint(json.dumps({"score": 0.75}))\n',
    );
    await Bun.write(join(dir, "cand.txt"), "x");
    expect((await lockEvalContract(dir)).ok).toBe(true);
  });
  afterEach(() =>
    Promise.all(
      [dir, stub].map((d) => rm(d, { recursive: true, force: true })),
    ),
  );

  test("eval runs in a container with only the project mounted and returns its eval_id", async () => {
    const result = await forward({ argv: ["eval", "cand.txt"], cwd: dir }, {});
    expect(result.code).toBe(0);
    const evalRuns = (await calls(stub)).filter((c) => c.startsWith("run "));
    expect(evalRuns).toHaveLength(2); // one container per seed
    for (const line of evalRuns) {
      expect(line).toContain("ml-ralph.sandbox=eval");
      expect(line).not.toContain("ANTHROPIC_API_KEY");
      expect(line).not.toContain(".config");
      const mounts = line.match(/-v (\S+)/g) ?? [];
      expect(mounts).toHaveLength(2); // the project, and the private evaluate.py copy
      expect(mounts[0]).toBe(`-v ${dir}:${dir}`);
      expect(mounts[1]).toMatch(/ml-ralph-eval-.*:ro$/);
    }
    const evalId = /^eval_id: (\S+)/m.exec(result.stdout)?.[1];
    expect(evalId).toMatch(/^eval-/);
    expect(
      await Bun.file(
        join(dir, ".ml-ralph/evals", evalId as string, "metrics.json"),
      ).exists(),
    ).toBe(true);
  });

  test("the experiment cap pinned by the runner applies to forwarded evals", async () => {
    const env = { ML_RALPH_ITERATION: "1", ML_RALPH_MAX_EXPERIMENTS: "1" };
    const request = { argv: ["eval", "cand.txt"], cwd: dir };
    expect((await forward(request, env)).code).toBe(0);
    const second = await forward(request, env);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("experiment cap reached");
  });

  test("job start runs in a container: nothing of the host environment or filesystem views reaches it", async () => {
    process.env.ML_RALPH_HOLDOUT_PATH = "/secret/holdout";
    process.env.SECRET_FOR_TEST = "leak";
    try {
      const result = await forward({
        argv: [
          "job",
          "start",
          "echo [$SECRET_FOR_TEST][$ML_RALPH_HOLDOUT_PATH][$HOME]",
        ],
        cwd: dir,
      });
      // returns once the job is recorded, without waiting for it
      expect(result.code).toBe(0);
      const jobId = /^job_id: (\S+)/m.exec(result.stdout)?.[1];
      expect(jobId).toMatch(/^job_/);
      expect(result.stdout).toContain("tail -f");
      const exitFile = join(dir, ".ml-ralph/runs/logs", `${jobId}.log.exit`);
      for (let i = 0; i < 100 && !(await Bun.file(exitFile).exists()); i++)
        await Bun.sleep(50);
      expect((await Bun.file(exitFile).text()).trim()).toBe("0");
      expect(
        await Bun.file(join(dir, ".ml-ralph/runs/logs", `${jobId}.log`)).text(),
      ).toBe("[][][/home/agent]\n");
      expect(await readActiveJobs(dir)).toEqual([]);
    } finally {
      delete process.env.ML_RALPH_HOLDOUT_PATH;
      delete process.env.SECRET_FOR_TEST;
    }
    const line = (await calls(stub)).find((c) =>
      c.startsWith("run "),
    ) as string;
    expect(line).toContain("ml-ralph.sandbox=job");
    expect(line).toContain("--cap-drop ALL");
    expect(line).toContain("--user ");
    expect(line.match(/-v (\S+)/g)).toEqual([`-v ${dir}:${dir}`]);
    expect(line).not.toContain("ANTHROPIC_API_KEY");
    expect(line).toContain(` ${SANDBOX_IMAGE} sh -c echo`);
  });

  test("the job record names its container, and stopping the job removes it", async () => {
    const started = Date.now();
    const result = await forward({
      argv: ["job", "start", "sleep 30"],
      cwd: dir,
    });
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000); // did not wait for the job
    let jobs: Awaited<ReturnType<typeof readActiveJobs>> = [];
    for (let i = 0; i < 100 && jobs.length === 0; i++) {
      await Bun.sleep(50);
      jobs = await readActiveJobs(dir);
    }
    const job = jobs[0] as (typeof jobs)[number];
    expect(job.container).toMatch(/^ml-ralph-/);
    const removed: string[] = [];
    await stopJob(dir, job, {
      graceMs: 20,
      removeContainer: (name) => removed.push(name),
    });
    await Bun.sleep(150);
    expect(removed).toContain(job.container as string);
    expect(await readActiveJobs(dir)).toEqual([]);
  });

  test("the holdout is scored in a container with the holdout and project read-only and no network", async () => {
    const sealed = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-sealed-"));
    const configHome = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-cfg-"));
    try {
      await Bun.write(join(sealed, "holdout.csv"), "y\n1\n");
      await Bun.write(
        join(configHome, "ml-ralph/config.json"),
        JSON.stringify({ projects: { [dir]: { holdout_path: sealed } } }),
      );
      const evaluated = await forward({ argv: ["eval", "cand.txt"], cwd: dir });
      const evalId = /^eval_id: (\S+)/m.exec(evaluated.stdout)?.[1] as string;
      const before = (await calls(stub)).length;

      const result = await scoreHoldout(evalId, {
        projectPath: dir,
        env: { XDG_CONFIG_HOME: configHome },
        wrap,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.holdoutScore).toBe(0.75);

      const lines = (await calls(stub))
        .slice(before)
        .filter((c) => c.startsWith("run "));
      expect(lines).toHaveLength(2); // one container per seed
      for (const line of lines) {
        expect(line).toContain("ml-ralph.sandbox=holdout");
        expect(line).toContain("--network none");
        expect(line).toContain("--read-only");
        expect(line).toContain("--tmpfs /tmp:rw,exec");
        expect(line).toContain(` -v ${dir}:${dir}:ro `);
        expect(line).toContain(` -v ${sealed}:${sealed}:ro `);
        expect(line).toContain(`ML_RALPH_HOLDOUT_PATH=${sealed}`);
        expect(line).not.toContain(".config");
        expect(line).not.toContain("ANTHROPIC_API_KEY");
      }
    } finally {
      await Promise.all(
        [sealed, configHome].map((d) =>
          rm(d, { recursive: true, force: true }),
        ),
      );
    }
  });

  test("holdout scoring finds the config entry by the configured path while mounting the real one", async () => {
    const sealed = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-sealed-"));
    const configHome = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-cfg-"));
    const link = `${dir}-link`;
    await symlink(dir, link);
    try {
      await Bun.write(
        join(configHome, "ml-ralph/config.json"),
        JSON.stringify({ projects: { [link]: { holdout_path: sealed } } }),
      );
      const evaluated = await forward({ argv: ["eval", "cand.txt"], cwd: dir });
      const evalId = /^eval_id: (\S+)/m.exec(evaluated.stdout)?.[1] as string;
      const real = await realpath(dir);
      const result = await scoreHoldout(evalId, {
        projectPath: link,
        mountPath: real,
        env: { XDG_CONFIG_HOME: configHome },
        wrap,
      });
      expect(result.ok).toBe(true);
      const line = (await calls(stub))
        .filter((c) => c.startsWith("run "))
        .find((c) => c.includes("sandbox=holdout")) as string;
      expect(line).toContain(` -v ${real}:${real}:ro `);
      expect(line).not.toContain(link);
    } finally {
      await rm(link, { force: true });
      await Promise.all(
        [sealed, configHome].map((d) =>
          rm(d, { recursive: true, force: true }),
        ),
      );
    }
  });

  test("log appends a validated event, reading stdin from the request", async () => {
    const event = JSON.stringify({
      type: "phase",
      phase: "EXECUTE",
      summary: "go",
    });
    const result = await forward(
      { argv: ["log", "phase", "-"], cwd: dir, stdin: event },
      {},
    );
    expect(result.code).toBe(0);
    expect(await Bun.file(join(dir, ".ml-ralph/log.jsonl")).text()).toContain(
      '"summary":"go"',
    );
  });

  test("runner-only log events are still refused", async () => {
    const result = await forward(
      { argv: ["log", "verifier_verdict", "{}"], cwd: dir },
      {},
    );
    expect(result.code).not.toBe(0);
  });

  test("anything else, a malformed request or a cwd outside the project is refused", async () => {
    const other = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-out-"));
    try {
      expect((await forward({ argv: ["init"], cwd: dir }, {})).code).toBe(2);
      expect((await forward({ argv: "eval" }, {})).code).toBe(2);
      const outside = await forward(
        { argv: ["eval", "cand.txt"], cwd: other },
        {},
      );
      expect(outside.code).toBe(1);
      expect(outside.stderr).toContain("outside the project");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("the container's shim and its bunx alias reach the host runner", async () => {
    const forwarder = await startForwarder({ projectPath: dir, env: {}, wrap });
    try {
      const sandboxDir = new URL("./sandbox/", import.meta.url).pathname;
      const env = {
        ...process.env,
        ML_RALPH_SANDBOX_DIR: join(dir, ".ml-ralph/sandbox"),
        PATH: `${sandboxDir}:${process.env.PATH}`,
      };
      // the image installs the shim as `ml-ralph`; here it is run by its source name
      const viaShim = Bun.spawn(
        [
          "python3",
          join(sandboxDir, "ml-ralph-forward.py"),
          "eval",
          "cand.txt",
        ],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(await new Response(viaShim.stdout).text()).toMatch(
        /eval_id: eval-/,
      );
      expect(await viaShim.exited).toBe(0);

      const refused = Bun.spawn(
        ["python3", join(sandboxDir, "ml-ralph-forward.py"), "init"],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(await refused.exited).toBe(2);
    } finally {
      forwarder.stop();
    }
  });

  test("the shim gives up with a clear error when the runner never answers", async () => {
    const sandboxDir = new URL("./sandbox/", import.meta.url).pathname;
    await mkdir(join(dir, ".ml-ralph/sandbox"), { recursive: true });
    const run = Bun.spawn(
      ["python3", join(sandboxDir, "ml-ralph-forward.py"), "eval", "cand.txt"],
      {
        cwd: dir,
        env: {
          ...process.env,
          ML_RALPH_SANDBOX_DIR: join(dir, ".ml-ralph/sandbox"),
          ML_RALPH_FORWARD_TIMEOUT_SECONDS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await run.exited).toBe(124);
    expect(await new Response(run.stderr).text()).toContain(
      "no answer from the host runner after 1s",
    );
  });

  test("a request file is answered by a response file, the way the shim uses it", async () => {
    const forwarder = await startForwarder({ projectPath: dir, env: {}, wrap });
    try {
      const id = "0123456789abcdef0123456789abcdef";
      const base = join(dir, ".ml-ralph/sandbox");
      await Bun.write(
        join(base, "requests", `${id}.json`),
        JSON.stringify({ argv: ["eval", "cand.txt"], cwd: dir, stdin: null }),
      );
      const responsePath = join(base, "responses", `${id}.json`);
      for (let i = 0; i < 200 && !(await Bun.file(responsePath).exists()); i++)
        await Bun.sleep(50);
      const result = await Bun.file(responsePath).json();
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/eval_id: eval-/);
      expect(await readdir(join(base, "requests"))).toEqual([]);
    } finally {
      forwarder.stop();
    }
  });
});

describe("the runner with --sandbox docker", () => {
  let dir: string;
  let stub: string;
  const saved = { key: process.env[API_KEY_ENV] };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-run-"));
    stub = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-stub-"));
    await Bun.write(join(dir, ".ml-ralph/RALPH.md"), "# instructions");
    process.env[API_KEY_ENV] = "sk-test";
  });
  afterEach(async () => {
    if (saved.key === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = saved.key;
    await Promise.all(
      [dir, stub].map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  const run = async (docker: string, maxIterations = 2) => {
    const errors: string[] = [];
    const completions: RunCompleteReason[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations,
      sandbox: "docker",
      dockerBin: docker,
      onError: (e) => errors.push(e.message),
      onComplete: (r) => completions.push(r),
    });
    await runner.start();
    return { runner, errors, completions };
  };

  test("each iteration's claude runs through docker run with the project as the only mount", async () => {
    const docker = await stubDocker(stub);
    const { errors, completions } = await run(docker);
    expect(errors).toEqual([]);
    expect(completions).toEqual(["max_iterations"]);
    const real = await realpath(dir);
    const runs = (await calls(stub)).filter((c) => c.startsWith("run "));
    expect(runs).toHaveLength(2);
    for (const line of runs) {
      expect(line).toContain(` -v ${real}:${real} `);
      expect(line.match(/ -v /g)).toHaveLength(1);
      expect(line).toContain(" claude --dangerously-skip-permissions ");
    }
    // containers are removed after each iteration
    expect(
      (await calls(stub)).filter((c) => c.startsWith("rm -f ml-ralph-")),
    ).toHaveLength(2);
  });

  test("refuses to start, naming the cause, and never runs claude", async () => {
    delete process.env[API_KEY_ENV];
    const docker = await stubDocker(stub);
    const { errors, completions } = await run(docker);
    expect(errors[0]).toContain("ANTHROPIC_API_KEY");
    expect(completions).toEqual([]);
    expect((await calls(stub)).filter((c) => c.startsWith("run "))).toEqual([]);

    process.env[API_KEY_ENV] = "sk-test";
    const down = await run(await stubDocker(stub, { info: false }));
    expect(down.errors[0]).toContain("Docker is unavailable");
  });

  test("stop() removes the running container", async () => {
    const docker = await stubDocker(stub, { run: "exec sleep 60" });
    const errors: string[] = [];
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations: 3,
      sandbox: "docker",
      dockerBin: docker,
      onError: (e) => errors.push(e.message),
    });
    const started = runner.start().catch(() => {});
    for (let i = 0; i < 200; i++) {
      if ((await calls(stub)).some((c) => c.startsWith("run "))) break;
      await Bun.sleep(25);
    }
    await runner.stop();
    await started;
    const all = await calls(stub);
    const name = /--name (\S+)/.exec(
      all.find((c) => c.startsWith("run ")) as string,
    )?.[1];
    expect(all).toContain(`rm -f ${name}`);
  });

  test("stop() also stops the jobs the agent started in containers", async () => {
    const docker = await stubDocker(stub, { run: "exec sleep 60" });
    const job = Bun.spawn(["sleep", "60"], { detached: true });
    const runner = new RalphRunner({
      projectPath: dir,
      maxIterations: 3,
      sandbox: "docker",
      dockerBin: docker,
      onError: () => {},
    });
    const started = runner.start().catch(() => {});
    for (let i = 0; i < 200; i++) {
      if ((await calls(stub)).some((c) => c.startsWith("run "))) break;
      await Bun.sleep(25);
    }
    // a job recorded after start, as a forwarded `job start` would
    await Bun.write(
      join(dir, ".ml-ralph/runs/active.json"),
      JSON.stringify({
        jobs: [
          {
            id: "job_1",
            storyId: "",
            experimentId: "",
            pid: job.pid,
            command: "sleep 60",
            logPath: join(dir, "j.log"),
            container: "ml-ralph-job-xyz",
            startedAt: new Date().toISOString(),
            status: "running",
          },
        ],
      }),
    );
    await runner.stop();
    await started;
    expect(await calls(stub)).toContain("rm -f ml-ralph-job-xyz");
    expect(await readActiveJobs(dir)).toEqual([]);
    for (let i = 0; i < 100 && job.exitCode === null; i++) await Bun.sleep(25);
    expect(job.exitCode === null && job.signalCode === null).toBe(false);
  });

  test("host mode never calls docker", async () => {
    const docker = await stubDocker(stub);
    await Bun.write(join(stub, "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(join(stub, "claude"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${stub}:${savedPath}`;
    try {
      const runner = new RalphRunner({
        projectPath: dir,
        maxIterations: 1,
        dockerBin: docker,
      });
      await runner.start();
    } finally {
      process.env.PATH = savedPath;
    }
    expect(await calls(stub)).toEqual([]);
  });
});

/** The isolation test needs a real daemon and the built image; without them it is skipped, and says why */
function dockerSkipReason(): string | null {
  if (!Bun.which("docker")) return "docker is not installed";
  const probe = (args: string[]) =>
    Bun.spawnSync(["docker", ...args], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0;
  if (!probe(["info"])) return "the docker daemon is not reachable";
  if (!probe(["image", "inspect", SANDBOX_IMAGE])) {
    return `image ${SANDBOX_IMAGE} is not built (${buildCommand()})`;
  }
  return null;
}
const skipReason = dockerSkipReason();
if (skipReason) console.log(`sandbox isolation test skipped: ${skipReason}`);

describe("the container", () => {
  test.skipIf(skipReason !== null)(
    "reading the holdout path and ~/.config/ml-ralph inside the container fails",
    async () => {
      const project = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-real-"));
      const sealed = await mkdtemp(join(tmpdir(), "ml-ralph-sbx-real-sealed-"));
      const configHome = await mkdtemp(
        join(tmpdir(), "ml-ralph-sbx-real-cfg-"),
      );
      try {
        await Bun.write(join(sealed, "holdout.csv"), "y\n1\n");
        await Bun.write(join(configHome, "ml-ralph/config.json"), "{}");
        const inside = (command: string) =>
          Bun.spawnSync(
            [
              "docker",
              ...containerArgs(
                {
                  projectPath: project,
                  name: `ml-ralph-test-${Date.now()}`,
                  env: {},
                  uid: process.getuid?.(),
                  gid: process.getgid?.(),
                },
                ["sh", "-c", command],
              ),
            ],
            {
              stdout: "pipe",
              stderr: "pipe",
              env: { ...process.env, [API_KEY_ENV]: "unused" },
            },
          );
        // the holdout container sees the holdout and the project, both read-only, and has no network
        const wrap = commandWrapper("docker", project);
        const scoring = (command: string) =>
          Bun.spawnSync(
            wrap(["sh", "-c", command], {
              kind: "holdout",
              readOnlyMounts: [sealed],
            }).argv,
            { stdout: "pipe", stderr: "pipe" },
          );
        expect(scoring(`cat ${join(sealed, "holdout.csv")}`).exitCode).toBe(0);
        expect(scoring(`touch ${join(project, "copied")}`).exitCode).not.toBe(
          0,
        );
        // /tmp is scratch space (tempfile works, as in search evals); nothing else is writable
        expect(
          scoring("echo x > /tmp/scratch && cat /tmp/scratch").exitCode,
        ).toBe(0);
        expect(scoring("touch /usr/local/x").exitCode).not.toBe(0);
        expect(
          scoring(`cat ${join(configHome, "ml-ralph/config.json")}`).exitCode,
        ).not.toBe(0);
        expect(
          scoring(
            "python3 -c \"import urllib.request as u; u.urlopen('http://1.1.1.1', timeout=3)\"",
          ).exitCode,
        ).not.toBe(0);
        expect(await Bun.file(join(project, "copied")).exists()).toBe(false);

        // the commands the runner forwards get the same mounts as the agent
        const forwarded = (command: string, kind: "job" | "eval" = "job") =>
          Bun.spawnSync(wrap(["sh", "-c", command], { kind }).argv, {
            stdout: "pipe",
            stderr: "pipe",
          });
        await Bun.write(join(project, "visible.txt"), "ok");
        expect(forwarded(`cat ${join(project, "visible.txt")}`).exitCode).toBe(
          0,
        );
        for (const kind of ["job", "eval"] as const) {
          expect(
            forwarded(`cat ${join(sealed, "holdout.csv")}`, kind).exitCode,
          ).not.toBe(0);
          expect(
            forwarded(`cat ${join(configHome, "ml-ralph/config.json")}`, kind)
              .exitCode,
          ).not.toBe(0);
          expect(forwarded("ls ~/.config/ml-ralph", kind).exitCode).not.toBe(0);
        }
        expect(inside(`cat ${join(sealed, "holdout.csv")}`).exitCode).not.toBe(
          0,
        );
        expect(
          inside(`cat ${join(configHome, "ml-ralph/config.json")}`).exitCode,
        ).not.toBe(0);
        expect(inside("ls ~/.config/ml-ralph").exitCode).not.toBe(0);
        // files written in the project belong to the host user
        expect(inside("touch owned-by-host-user").exitCode).toBe(0);
        const owner =
          (await Bun.file(join(project, "owned-by-host-user")).exists()) &&
          (
            await Bun.$`stat -c %u ${join(project, "owned-by-host-user")}`.text()
          ).trim();
        expect(owner).toBe(String(process.getuid?.()));
      } finally {
        await Promise.all(
          [project, sealed, configHome].map((d) =>
            rm(d, { recursive: true, force: true }),
          ),
        );
      }
    },
  );
});
