import { assertSafeRevision } from "../deploys/run-git.js";
import { applyPathMap, isRepoRelativePath } from "./apply-path-map.js";
import { DEFAULT_LANGUAGE } from "../log-parsing/languages.js";
import { categorizeChangedFile } from "./changed-file-categories.js";
import {
  blameLine,
  listChangedFiles,
  listChangedFilesByCommit,
  listCommitsChangingFunction,
  listCommitsChangingLines,
  readBlameIgnoreRevisions,
  readFileAtCommit,
} from "./git-blame-reader.js";
import { CODE_RULES, type CodeRules } from "./language-code-rules.js";
import { scoreSuspects } from "./score-suspects.js";
import type { AttributionInput, AttributionResult, Finding } from "./suspect-types.js";

export const FIRST_DEPLOY_MESSAGE = "first deploy, nothing to compare";

const FALLBACK_CONTEXT_LINES = 3;

interface RepoFrame {
  frameIndex: number;
  filePath: string;
  lineNumber: number;
  functionName: string | undefined;
  fileContent: string;
  lineCount: number;
}

function countLines(fileContent: string): number {
  const fileLines = fileContent.split("\n");
  return fileContent.endsWith("\n") ? fileLines.length - 1 : fileLines.length;
}

function readLineText(fileContent: string, lineNumber: number): string | null {
  return fileContent.split("\n")[lineNumber - 1] ?? null;
}

function hasLine(frame: RepoFrame, lineNumber: number): boolean {
  return Number.isInteger(lineNumber) && lineNumber >= 1 && lineNumber <= frame.lineCount;
}

function makeFinding(fields: Pick<Finding, "commitSha" | "strength" | "frameIndex" | "filePath"> & Partial<Finding>): Finding {
  return { lineNumber: null, lineText: null, functionName: null, calleeName: null, fileCategory: null, ...fields };
}

async function readRepoFrames(input: AttributionInput, deploySha: string, rules: CodeRules): Promise<RepoFrame[]> {
  const repoFrames: RepoFrame[] = [];
  for (const [frameIndex, frame] of input.topFrames.entries()) {
    if (rules.isLibraryFrame(frame.file)) continue;
    const filePath = applyPathMap(frame.file, input.pathMap);
    if (!isRepoRelativePath(filePath)) continue;
    const fileContent = await readFileAtCommit(input.repoPath, deploySha, filePath);
    if (fileContent === undefined) continue;
    repoFrames.push({
      frameIndex,
      filePath,
      lineNumber: frame.line,
      functionName: rules.readPlainFunctionName(frame.fn),
      fileContent,
      lineCount: countLines(fileContent),
    });
  }
  return repoFrames;
}

// The commits in the deploy that changed a named function. undefined means
// the function could not be found, so the caller decides what to do instead.
async function listCommitsChangingNamedFunction(
  repoPath: string,
  previousSha: string,
  deploySha: string,
  filePath: string,
  fileContent: string,
  functionName: string,
  rules: CodeRules,
  lineNumberInside?: number,
): Promise<string[] | undefined> {
  if (rules.findFunctionLineRange === null) return listCommitsChangingFunction(repoPath, previousSha, deploySha, filePath, functionName);
  const functionRange = rules.findFunctionLineRange(fileContent, functionName, lineNumberInside);
  if (functionRange === undefined) return undefined;
  return listCommitsChangingLines(repoPath, previousSha, deploySha, filePath, functionRange.startLine, functionRange.endLine);
}

async function listCommitsChangingFrameFunction(
  repoPath: string,
  previousSha: string,
  deploySha: string,
  frame: RepoFrame,
  rules: CodeRules,
): Promise<string[]> {
  if (frame.functionName !== undefined) {
    const commitShas = await listCommitsChangingNamedFunction(
      repoPath, previousSha, deploySha, frame.filePath, frame.fileContent, frame.functionName, rules, frame.lineNumber,
    );
    if (commitShas !== undefined) return commitShas;
  }
  if (!hasLine(frame, frame.lineNumber)) return [];
  const startLine = Math.max(1, frame.lineNumber - FALLBACK_CONTEXT_LINES);
  const endLine = Math.min(frame.lineCount, frame.lineNumber + FALLBACK_CONTEXT_LINES);
  return listCommitsChangingLines(repoPath, previousSha, deploySha, frame.filePath, startLine, endLine);
}

async function collectTopFrameFindings(
  repoPath: string,
  previousSha: string,
  deploySha: string,
  topFrame: RepoFrame,
  ignoredRevisions: string[],
  rules: CodeRules,
): Promise<Finding[]> {
  if (!hasLine(topFrame, topFrame.lineNumber)) return [];
  const findings: Finding[] = [];
  const frameFields = { frameIndex: topFrame.frameIndex, functionName: topFrame.functionName ?? null };

  const blamedLine = await blameLine(repoPath, deploySha, topFrame.filePath, topFrame.lineNumber, ignoredRevisions);
  findings.push(
    makeFinding({
      ...frameFields,
      commitSha: blamedLine.commitSha,
      strength: "blamed-line",
      filePath: topFrame.filePath,
      lineNumber: topFrame.lineNumber,
      lineText: blamedLine.lineText,
    }),
  );

  const crashLineInputs = rules.findCrashLineInputs(topFrame.fileContent, topFrame.lineNumber, topFrame.functionName);

  for (const inputLineNumber of crashLineInputs.inputLineNumbers) {
    const blamedInputLine = await blameLine(repoPath, deploySha, topFrame.filePath, inputLineNumber, ignoredRevisions);
    findings.push(
      makeFinding({
        ...frameFields,
        commitSha: blamedInputLine.commitSha,
        strength: "crash-input-line",
        filePath: topFrame.filePath,
        lineNumber: inputLineNumber,
        lineText: blamedInputLine.lineText,
      }),
    );
  }

  for (const calleeName of crashLineInputs.calleeNames) {
    const calleeLocation = rules.findCalleeLocation(topFrame.fileContent, topFrame.filePath, calleeName);
    if (calleeLocation === undefined) continue;
    for (const candidatePath of calleeLocation.candidatePaths) {
      const calleeFileContent = await readFileAtCommit(repoPath, deploySha, candidatePath);
      if (calleeFileContent === undefined) continue;
      const definitionLine = rules.findFunctionDefinitionLine(calleeFileContent, calleeLocation.definitionName);
      const commitShas = definitionLine
        ? ((await listCommitsChangingNamedFunction(
            repoPath, previousSha, deploySha, candidatePath, calleeFileContent, calleeLocation.definitionName, rules,
          )) ?? [])
        : [];
      for (const commitSha of commitShas) {
        findings.push(
          makeFinding({
            ...frameFields,
            commitSha,
            strength: "crash-input-callee",
            filePath: candidatePath,
            lineNumber: definitionLine!.lineNumber,
            lineText: definitionLine!.lineText,
            calleeName: calleeLocation.definitionName,
          }),
        );
      }
      break;
    }
  }
  return findings;
}

export async function attributeRegression(input: AttributionInput): Promise<AttributionResult> {
  const { repoPath, deploySha, previousSha } = input;
  if (previousSha === null) return { suspects: [], message: FIRST_DEPLOY_MESSAGE };
  assertSafeRevision(deploySha, "sha");
  assertSafeRevision(previousSha, "sha");

  const changedFiles = await listChangedFiles(repoPath, previousSha, deploySha);
  const changedFilesByCommit = await listChangedFilesByCommit(repoPath, previousSha, deploySha);
  const ignoredRevisions = await readBlameIgnoreRevisions(repoPath, deploySha);
  const rules = CODE_RULES[input.language ?? DEFAULT_LANGUAGE];
  const repoFrames = await readRepoFrames(input, deploySha, rules);
  const findings: Finding[] = [];

  const commitsChangingFile = (filePath: string) =>
    [...changedFilesByCommit.entries()].filter(([, commitFiles]) => commitFiles.includes(filePath)).map(([commitSha]) => commitSha);

  const topFrame = repoFrames[0];
  if (topFrame !== undefined) findings.push(...(await collectTopFrameFindings(repoPath, previousSha, deploySha, topFrame, ignoredRevisions, rules)));

  for (const frame of repoFrames) {
    const frameFields = { frameIndex: frame.frameIndex, filePath: frame.filePath, functionName: frame.functionName ?? null };
    const isTopFrame = frame === topFrame;
    for (const commitSha of await listCommitsChangingFrameFunction(repoPath, previousSha, deploySha, frame, rules)) {
      findings.push(
        makeFinding({
          ...frameFields,
          commitSha,
          strength: isTopFrame ? "same-function" : "lower-frame-function",
          lineNumber: frame.lineNumber,
          lineText: readLineText(frame.fileContent, frame.lineNumber),
        }),
      );
    }
    if (changedFiles.includes(frame.filePath)) {
      for (const commitSha of commitsChangingFile(frame.filePath)) findings.push(makeFinding({ ...frameFields, commitSha, strength: "file" }));
    }
  }

  for (const filePath of changedFiles) {
    const fileCategory = categorizeChangedFile(filePath);
    if (fileCategory === undefined) continue;
    for (const commitSha of commitsChangingFile(filePath)) {
      findings.push(makeFinding({ commitSha, strength: "dependency-or-config", frameIndex: input.topFrames.length, filePath, fileCategory }));
    }
  }

  return scoreSuspects({ findings, commitsInRange: input.commitsInRange, changedFilesByCommit });
}
