import { extractPrNumber } from "./pull-request-number.js";
import { assertSafeRevision, runGitOrThrow } from "./run-git.js";
import { toUtcIso } from "./utc-timestamp.js";

export interface RangeCommit {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  time: string;
  prNumber: number | null;
}

export async function listCommitsInRange(repoPath: string, previousSha: string | null, sha: string): Promise<RangeCommit[]> {
  if (previousSha === null) return [];
  assertSafeRevision(previousSha, "sha");
  assertSafeRevision(sha, "sha");
  const gitOutput = await runGitOrThrow(repoPath, ["rev-list", "--format=%H%x00%s%x00%an%x00%ae%x00%aI", `${previousSha}..${sha}`, "--"]);
  const commits: RangeCommit[] = [];
  for (const line of gitOutput.split("\n")) {
    if (line === "" || line.startsWith("commit ")) continue;
    const [commitSha = "", subject = "", authorName = "", authorEmail = "", time = ""] = line.split("\0");
    commits.push({
      sha: commitSha,
      subject,
      authorName,
      authorEmail,
      time: toUtcIso(time) ?? time,
      prNumber: extractPrNumber(subject),
    });
  }
  return commits.reverse();
}
