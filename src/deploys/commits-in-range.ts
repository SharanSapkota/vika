// Lists the commits one deploy shipped, for attribution later.
import { extractPrNumber } from "./pull-request-number.js";
import { assertSafeRevision, runGitOrThrow } from "./run-git.js";
import { toUtcIso } from "./utc-timestamp.js";

// One commit in a deploy's range. Uses the AUTHOR, not the committer.
export interface RangeCommit {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  time: string; // author time, ISO, UTC
  prNumber: number | null;
}

// The commits a deploy shipped: git rev-list previousSha..sha, oldest first.
// A starting point (previousSha null) shipped nothing we can blame.
export async function listCommitsInRange(repoPath: string, previousSha: string | null, sha: string): Promise<RangeCommit[]> {
  if (previousSha === null) return [];
  assertSafeRevision(previousSha, "sha");
  assertSafeRevision(sha, "sha");
  // Fields separated by NUL, which can't appear in names or subjects.
  const gitOutput = await runGitOrThrow(repoPath, ["rev-list", "--format=%H%x00%s%x00%an%x00%ae%x00%aI", `${previousSha}..${sha}`, "--"]);
  const commits: RangeCommit[] = [];
  for (const line of gitOutput.split("\n")) {
    // rev-list prints a "commit <sha>" line before each formatted line.
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
