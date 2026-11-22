// READ-ONLY git. For each of the top suspects, reads what its commit changed
// in the files that matter: the files in the stack trace plus the suspect's
// own file. Runs `git show` in the customer's repo with an argument list (no
// shell). Never checks out, fetches, pulls or writes anything.
import { assertSafeRevision, runGit } from "../deploys/run-git.js";
import { assertSafePath } from "../suspect-attribution/git-blame-reader.js";
import type { Suspect } from "../suspect-attribution/suspect-types.js";
import type { SuspectDiff } from "./explanation-types.js";
import { MAX_SUSPECTS_SENT } from "./build-explanation-request.js";

export interface ReadSuspectDiffsInput {
  repoPath: string;
  suspects: Suspect[]; // only the first 3 are read
  stackTraceFilePaths: string[]; // repo-relative paths from the stack trace
}

// Refuses anything git could read as an option (a ref or path starting
// with "-") before git is ever started.
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
      // Only the commit and its subject: author names and emails stay out.
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
