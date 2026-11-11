/**
 * Claude auth check - bench spends real money, so it refuses to start without a login
 */

export type ClaudeAuth = { ok: true } | { ok: false; error: string };

/** Runs `claude auth status` and returns its stdout and exit code; replaced in tests */
export type AuthStatusRunner = () => Promise<{ code: number; stdout: string }>;

const runAuthStatus: AuthStatusRunner = async () => {
  const proc = Bun.spawn(["claude", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { code, stdout };
};

/** The claude CLI must report `loggedIn: true` (subscription login or API key) */
export async function checkClaudeAuth(
  run: AuthStatusRunner = runAuthStatus,
): Promise<ClaudeAuth> {
  const fix = "Run `claude auth login` (or set ANTHROPIC_API_KEY) and retry.";
  let status: { code: number; stdout: string };
  try {
    status = await run();
  } catch {
    return {
      ok: false,
      error: `bench needs the claude CLI, and it could not be run. Install Claude Code and log in. ${fix}`,
    };
  }
  let loggedIn = false;
  try {
    loggedIn =
      (JSON.parse(status.stdout) as { loggedIn?: unknown } | null)?.loggedIn ===
      true;
  } catch {
    // Not JSON: treat as not logged in
  }
  return loggedIn && status.code === 0
    ? { ok: true }
    : { ok: false, error: `claude is not authenticated. ${fix}` };
}
