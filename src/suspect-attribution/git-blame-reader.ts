// READ-ONLY git reads for suspect attribution: file contents, blame, and
// which commits in a deploy changed which files, lines and functions.
//
// Safety: only blame, diff, log and show are run, always through runGit (no
// shell, arguments as an array, cwd = the repo path). Code is always read at
// the deployed sha, never at HEAD or in the working tree. Refs and paths
// that start with "-" are refused so git can never read them as options.
import { assertSafeRevision, runGit, runGitOrThrow } from "../deploys/run-git.js";
import { escapeForRegex } from "./function-names.js";

// Printed before each commit sha in `git log` output, so commit lines can be
// told apart from file names and diff lines (none of which start with it).
const COMMIT_MARKER = "vika-commit ";
const COMMIT_LINE = /^vika-commit ([0-9a-f]{40}|[0-9a-f]{64})$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function assertSafePath(filePath: string): void {
  if (filePath === "" || filePath.startsWith("-") || /[\0\n\r]/.test(filePath)) throw new Error(`invalid path: "${filePath}"`);
}

// Commit shas from `git log --format="vika-commit %H"` output, in log order.
function parseCommitLines(gitOutput: string): string[] {
  const commitShas: string[] = [];
  for (const line of gitOutput.split("\n")) {
    const commitMatch = COMMIT_LINE.exec(line);
    if (commitMatch) commitShas.push(commitMatch[1]!);
  }
  return commitShas;
}

// The file's content at `commitSha`, or undefined if it doesn't exist there.
export async function readFileAtCommit(repoPath: string, commitSha: string, filePath: string): Promise<string | undefined> {
  assertSafeRevision(commitSha, "sha");
  assertSafePath(filePath);
  // --no-textconv: the stored content, not a filter's rendering of it.
  const result = await runGit(repoPath, ["show", "--no-textconv", `${commitSha}:${filePath}`, "--"]);
  return result.exitCode === 0 ? result.stdout : undefined;
}

// Commits listed in .git-blame-ignore-revs at the deployed sha (formatting
// sweeps and the like), so blame looks past them. Empty if there is no file.
export async function readBlameIgnoreRevisions(repoPath: string, deploySha: string): Promise<string[]> {
  const fileContent = await readFileAtCommit(repoPath, deploySha, ".git-blame-ignore-revs");
  if (fileContent === undefined) return [];
  return fileContent
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => FULL_SHA.test(line));
}

export interface BlamedLine {
  commitSha: string;
  lineText: string;
  authorName: string;
  authorEmail: string;
}

function parseBlamePorcelain(blameOutput: string): BlamedLine {
  const outputLines = blameOutput.split("\n");
  const commitSha = /^([0-9a-f]{40}|[0-9a-f]{64}) /.exec(outputLines[0] ?? "")?.[1];
  if (commitSha === undefined) throw new Error("unexpected git blame output");
  let authorName = "";
  let authorEmail = "";
  let lineText = "";
  for (const line of outputLines.slice(1)) {
    // The line's own text comes last, after a tab.
    if (line.startsWith("\t")) {
      lineText = line.slice(1);
      break;
    }
    if (line.startsWith("author ")) authorName = line.slice("author ".length);
    else if (line.startsWith("author-mail ")) authorEmail = line.slice("author-mail ".length).replace(/^<|>$/g, "");
  }
  return { commitSha, lineText, authorName, authorEmail };
}

// Who last changed one line, as of the deployed sha. -w ignores whitespace
// changes; -M and -C follow lines moved or copied within and across files,
// so a reformat or a move doesn't hide the commit that wrote the line.
export async function blameLine(
  repoPath: string,
  deploySha: string,
  filePath: string,
  lineNumber: number,
  ignoredRevisions: string[],
): Promise<BlamedLine> {
  assertSafeRevision(deploySha, "sha");
  assertSafePath(filePath);
  const blameArguments = (revisionsToIgnore: string[]) => [
    "blame",
    "-w",
    "-M",
    "-C",
    ...revisionsToIgnore.flatMap((revision) => ["--ignore-rev", revision]),
    "-L",
    `${lineNumber},${lineNumber}`,
    "--porcelain",
    deploySha,
    "--",
    filePath,
  ];
  const result = await runGit(repoPath, blameArguments(ignoredRevisions));
  if (result.exitCode === 0) return parseBlamePorcelain(result.stdout);
  // An ignore file can list commits this clone doesn't have, and git refuses
  // to run then. A plain blame is better than none.
  if (ignoredRevisions.length > 0) return parseBlamePorcelain(await runGitOrThrow(repoPath, blameArguments([])));
  throw new Error(`git blame failed in ${repoPath}: ${result.stderr.trim()}`);
}

// Files that differ between the two deploys: git diff --name-only previousSha..deploySha.
export async function listChangedFiles(repoPath: string, previousSha: string, deploySha: string): Promise<string[]> {
  assertSafeRevision(previousSha, "sha");
  assertSafeRevision(deploySha, "sha");
  const gitOutput = await runGitOrThrow(repoPath, ["diff", "--name-only", `${previousSha}..${deploySha}`, "--"]);
  return gitOutput.split("\n").filter((filePath) => filePath !== "");
}

// Which files each commit in the range changed: commit sha -> file paths.
export async function listChangedFilesByCommit(repoPath: string, previousSha: string, deploySha: string): Promise<Map<string, string[]>> {
  assertSafeRevision(previousSha, "sha");
  assertSafeRevision(deploySha, "sha");
  const gitOutput = await runGitOrThrow(repoPath, ["log", `--format=${COMMIT_MARKER}%H`, "--name-only", `${previousSha}..${deploySha}`, "--"]);
  const changedFilesByCommit = new Map<string, string[]>();
  let currentFiles: string[] | undefined;
  for (const line of gitOutput.split("\n")) {
    const commitMatch = COMMIT_LINE.exec(line);
    if (commitMatch) {
      currentFiles = [];
      changedFilesByCommit.set(commitMatch[1]!, currentFiles);
    } else if (line !== "" && currentFiles !== undefined) {
      currentFiles.push(line);
    }
  }
  return changedFilesByCommit;
}

// Commits in previousSha..deploySha that changed the function `functionName`
// in `filePath` (git log -L :function:file). Undefined when git can't find
// the function in the file, so the caller can fall back to a line range.
export async function listCommitsChangingFunction(
  repoPath: string,
  previousSha: string,
  deploySha: string,
  filePath: string,
  functionName: string,
): Promise<string[] | undefined> {
  assertSafeRevision(previousSha, "sha");
  assertSafeRevision(deploySha, "sha");
  assertSafePath(filePath);
  // git reads the name as a regex. Names are plain identifiers (letters,
  // digits, "_" and "$"), so escaping "$" is all that matters.
  const result = await runGit(repoPath, [
    "log",
    "-s", // commit lines only, no patches
    `--format=${COMMIT_MARKER}%H`,
    "-L",
    `:${escapeForRegex(functionName)}:${filePath}`,
    `${previousSha}..${deploySha}`,
    "--",
  ]);
  return result.exitCode === 0 ? parseCommitLines(result.stdout) : undefined;
}

// Commits in previousSha..deploySha that changed lines startLine..endLine of
// `filePath` (line numbers as of deploySha).
export async function listCommitsChangingLines(
  repoPath: string,
  previousSha: string,
  deploySha: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<string[]> {
  assertSafeRevision(previousSha, "sha");
  assertSafeRevision(deploySha, "sha");
  assertSafePath(filePath);
  const gitOutput = await runGitOrThrow(repoPath, [
    "log",
    "-s",
    `--format=${COMMIT_MARKER}%H`,
    "-L",
    `${startLine},${endLine}:${filePath}`,
    `${previousSha}..${deploySha}`,
    "--",
  ]);
  return parseCommitLines(gitOutput);
}
