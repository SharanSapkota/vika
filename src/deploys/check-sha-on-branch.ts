import { assertSafeRevision, resolveCommit, runGit } from "./run-git.js";

export async function checkShaOnBranch(repoPath: string, sha: string, branch: string): Promise<{ onBranch: boolean; reason?: string }> {
  assertSafeRevision(sha, "sha");
  assertSafeRevision(branch, "branch");
  if ((await resolveCommit(repoPath, branch)) === undefined) {
    return { onBranch: false, reason: `branch "${branch}" does not exist in ${repoPath}` };
  }
  if ((await resolveCommit(repoPath, sha)) === undefined) {
    return { onBranch: false, reason: `commit ${sha} does not exist in ${repoPath}` };
  }
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", sha, branch]);
  if (result.exitCode === 0) return { onBranch: true };
  if (result.exitCode === 1) return { onBranch: false, reason: `commit ${sha} is not on branch "${branch}"` };
  throw new Error(`git merge-base failed in ${repoPath}: ${result.stderr.trim()}`);
}
