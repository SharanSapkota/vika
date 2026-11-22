



import { assertSafeRevision, runGit } from "../deploys/run-git.js";
import { assertSafePath } from "../suspect-attribution/git-blame-reader.js";
import type { Suspect } from "../suspect-attribution/suspect-types.js";
import type { SuspectDiff } from "./explanation-types.js";
import { MAX_SUSPECTS_SENT } from "./build-explanation-request.js";

export interface ReadSuspectDiffsInput {
  repoPath: string;
  suspects: Suspect[]; 
  stackTraceFilePaths: string[]; 
}



function assertSafeShowArguments(commitSha: string, filePaths: string[]): void {
  assertSafeRevision(commitSha, "commit");
  for (const filePath of filePaths) assertSafePath(filePath);
}

export async function readSuspectDiffs(input: ReadSuspectDiffsInput): Promise<SuspectDiff[]> {
  const suspectDiffs: SuspectDiff[] = [];
  for (const suspect of input.suspects.slice(0, MAX_SUSPECTS_SENT)) {
    const filePaths = [...new Set([...input.stackTraceFilePaths, suspect.filePath].filter((filePath) => filePath !== ""))];
    assertSafeShowArguments(suspect.commitSha, filePaths);
    if (filePaths.length === 0) {
      suspectDiffs.push({ commitSha: suspect.commitSha, diffText: null, problem: "no files to show" });
      continue;
    }
    const result = await runGit(input.repoPath, [
      "show",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      
      "--format=commit %H%nsubject: %s",
      suspect.commitSha,
      "--",
      ...filePaths,
    ]);
    suspectDiffs.push(
      result.exitCode === 0
        ? { commitSha: suspect.commitSha, diffText: result.stdout, problem: null }
        : { commitSha: suspect.commitSha, diffText: null, problem: `git show failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}` },
    );
  }
  return suspectDiffs;
}
