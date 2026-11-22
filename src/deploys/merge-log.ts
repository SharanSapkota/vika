import type { Deploy } from "../database/store-types.js";
import { toUtcIso } from "./utc-timestamp.js";

export interface MergeCommit {
  sha: string;
  parents: string[];
  time: string;
  subject: string;
}

export const MERGE_LOG_FORMAT = "%H|%P|%cI|%s";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function parseMergeLog(gitLogOutput: string): { commits: MergeCommit[]; skipped: number } {
  const commits: MergeCommit[] = [];
  let skipped = 0;
  for (const line of gitLogOutput.split("\n")) {
    if (line.trim() === "") continue;
    const [sha = "", parents = "", time = "", ...subjectParts] = line.split("|");
    const parentShas = parents.split(" ").filter((parentSha) => parentSha !== "");
    const utcTime = toUtcIso(time);
    if (
      !FULL_SHA.test(sha) ||
      !parentShas.every((parentSha) => FULL_SHA.test(parentSha)) ||
      utcTime === undefined ||
      subjectParts.length === 0
    ) {
      skipped++;
      continue;
    }
    commits.push({ sha, parents: parentShas, time: utcTime, subject: subjectParts.join("|") });
  }
  return { commits: commits.reverse(), skipped };
}

export function mergesToDeploys(service: string, commits: MergeCommit[]): Deploy[] {
  return commits.map((commit, index) => ({
    service,
    sha: commit.sha,
    previousSha: commits[index - 1]?.sha ?? null,
    time: commit.time,
    source: "merges",
  }));
}
