// Runs READ-ONLY git commands in the customer's repo (cwd = the repo path
// from the config). Arguments are always passed as an array, never as a
// shell string, and nothing from a log ever ends up in a command.
import { spawn } from "node:child_process";

// git's environment: the caller's, minus any GIT_* variables (inside a git
// hook GIT_DIR would point at a different repo), plus:
//   no password prompts, no optional lock files, stable English messages.
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) environment[key] = value;
  return { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Runs one git command in the repo. Never through a shell.
export function runGit(repoPath: string, gitArguments: string[]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...gitArguments], {
      cwd: repoPath,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`cannot run git in ${repoPath}: ${error.message}`)));
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}

// Runs git and returns stdout, or throws with git's own error message.
export async function runGitOrThrow(repoPath: string, gitArguments: string[]): Promise<string> {
  const result = await runGit(repoPath, gitArguments);
  if (result.exitCode !== 0) throw new Error(`git ${gitArguments[0]} failed in ${repoPath}: ${result.stderr.trim()}`);
  return result.stdout;
}

// Branch names and shas come from config or the database, but a value that
// starts with "-" would be read by git as an option, so refuse it.
export function assertSafeRevision(revision: string, description: string): void {
  if (revision === "" || revision.startsWith("-") || /\s/.test(revision)) throw new Error(`invalid ${description}: "${revision}"`);
}

// The full sha a branch/sha points at, or undefined if it doesn't exist.
export async function resolveCommit(repoPath: string, revision: string): Promise<string | undefined> {
  const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}
