import type { Deploy } from "../database/store-types.js";
import { MERGE_LOG_FORMAT, mergesToDeploys, parseMergeLog, type MergeCommit } from "./merge-log.js";
import { assertSafeRevision, resolveCommit, runGitOrThrow } from "./run-git.js";

const PARALLEL_GIT_PROCESSES = 8;

async function requireBranch(repoPath: string, branch: string): Promise<void> {
  assertSafeRevision(branch, "branch");
  if ((await resolveCommit(repoPath, branch)) === undefined) {
    throw new Error(`branch "${branch}" does not exist in ${repoPath}`);
  }
}

async function changedFiles(repoPath: string, commit: MergeCommit): Promise<string[]> {
  const parentSha = commit.parents[0];
  const diffArguments = parentSha === undefined ? ["--root", commit.sha] : [parentSha, commit.sha];
  const gitOutput = await runGitOrThrow(repoPath, ["diff-tree", "-r", "--name-only", "--no-commit-id", ...diffArguments]);
  return gitOutput.split("\n").filter((filePath) => filePath !== "");
}

async function commitsTouching(repoPath: string, commits: MergeCommit[], prefix: string): Promise<MergeCommit[]> {
  const directoryPrefix = prefix.replace(/^\.?\/+/, "").replace(/\/*$/, "/");
  const isTouchingPrefix: boolean[] = new Array<boolean>(commits.length).fill(false);
  let nextCommitIndex = 0;
  const worker = async () => {
    while (nextCommitIndex < commits.length) {
      const commitIndex = nextCommitIndex++;
      isTouchingPrefix[commitIndex] = (await changedFiles(repoPath, commits[commitIndex]!)).some(
        (filePath) => directoryPrefix === "/" || filePath.startsWith(directoryPrefix),
      );
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_GIT_PROCESSES }, worker));
  return commits.filter((_commit, commitIndex) => isTouchingPrefix[commitIndex]);
}

export async function readMergeDeploys(repoPath: string, branch: string, service: string, pathPrefix?: string): Promise<Deploy[]> {
  await requireBranch(repoPath, branch);
  const gitOutput = await runGitOrThrow(repoPath, ["log", "--first-parent", `--format=${MERGE_LOG_FORMAT}`, branch, "--"]);
  let { commits } = parseMergeLog(gitOutput);
  if (pathPrefix !== undefined) commits = await commitsTouching(repoPath, commits, pathPrefix);
  return mergesToDeploys(service, commits);
}
