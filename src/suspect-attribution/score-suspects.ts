import type { RangeCommit } from "../deploys/commits-in-range.js";
import { extractPrNumber } from "../deploys/pull-request-number.js";
import { isBotAuthor } from "./bot-authors.js";
import type { AttributionResult, Confidence, EvidenceKind, Finding, FindingStrength, Suspect } from "./suspect-types.js";

export const MAX_SUSPECTS = 3;
export const NO_STRONG_SUSPECT_MESSAGE = "no strong suspect in this deploy; may be external";

interface StrengthDetails {
  rank: number;
  confidence: Confidence;
  evidenceKind: EvidenceKind;
}

const STRENGTH_DETAILS: Record<FindingStrength, StrengthDetails> = {
  "blamed-line": { rank: 7, confidence: "high", evidenceKind: "blamed-line-changed" },
  "crash-input-line": { rank: 6, confidence: "high", evidenceKind: "same-function-changed" },
  "crash-input-callee": { rank: 5, confidence: "high", evidenceKind: "call-chain-function-changed" },
  "same-function": { rank: 4, confidence: "medium", evidenceKind: "same-function-changed" },
  "lower-frame-function": { rank: 3, confidence: "medium", evidenceKind: "call-chain-function-changed" },
  file: { rank: 2, confidence: "medium", evidenceKind: "file-changed" },
  "dependency-or-config": { rank: 1, confidence: "medium", evidenceKind: "dependency-or-config-change" },
};
const TIMING_ONLY_DETAILS: StrengthDetails = { rank: 0, confidence: "low", evidenceKind: "timing-only" };

export interface ScoreInput {
  findings: Finding[];
  commitsInRange: RangeCommit[];
  changedFilesByCommit: Map<string, string[]>;
}

const describeFunction = (functionName: string | null) => (functionName === null ? "the code" : `${functionName}()`);

function writeReason(finding: Finding): string {
  const functionText = describeFunction(finding.functionName);
  switch (finding.strength) {
    case "blamed-line":
      return `Line ${finding.lineNumber} of ${finding.filePath}, where the error is thrown, was last changed by this commit.`;
    case "crash-input-line":
      return `This commit changed line ${finding.lineNumber} of ${finding.filePath}, which sets a value the failing line in ${functionText} reads.`;
    case "crash-input-callee":
      return `This commit changed ${finding.calleeName}() in ${finding.filePath}, and the failing line in ${functionText} uses what it returns.`;
    case "same-function":
      return `This commit changed ${functionText} in ${finding.filePath}, the function where the error is thrown.`;
    case "lower-frame-function":
      return `This commit changed ${functionText} in ${finding.filePath}, which is further down the stack trace.`;
    case "file":
      return `This commit changed ${finding.filePath}, which appears in the stack trace.`;
    case "dependency-or-config":
      return `This commit changed ${finding.filePath}, a ${finding.fileCategory ?? "config file"}, in this deploy.`;
  }
}

function buildSuspect(commit: RangeCommit, details: StrengthDetails, fields: Pick<Suspect, "reason" | "filePath" | "lineNumber" | "lineText">): Suspect {
  return {
    commitSha: commit.sha,
    prNumber: extractPrNumber(commit.subject),
    confidence: details.confidence,
    evidenceKind: details.evidenceKind,
    reason: fields.reason,
    filePath: fields.filePath,
    lineNumber: fields.lineNumber,
    lineText: fields.lineText,
    author: { name: commit.authorName, email: commit.authorEmail },
    isInDeployRange: true,
    isBot: isBotAuthor(commit.authorName, commit.authorEmail),
  };
}

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function scoreSuspects(input: ScoreInput): AttributionResult {
  const rangePositionBySha = new Map(input.commitsInRange.map((commit, rangePosition) => [commit.sha, rangePosition]));

  const findingsInRange = input.findings.filter((finding) => rangePositionBySha.has(finding.commitSha));

  findingsInRange.sort(
    (left, right) =>
      STRENGTH_DETAILS[right.strength].rank - STRENGTH_DETAILS[left.strength].rank ||
      left.frameIndex - right.frameIndex ||
      rangePositionBySha.get(left.commitSha)! - rangePositionBySha.get(right.commitSha)! ||
      compareStrings(left.filePath, right.filePath) ||
      (left.lineNumber ?? Infinity) - (right.lineNumber ?? Infinity),
  );

  const rankedSuspects: Suspect[] = [];
  const suspectedShas = new Set<string>();
  for (const finding of findingsInRange) {
    if (suspectedShas.has(finding.commitSha)) continue;
    suspectedShas.add(finding.commitSha);
    const commit = input.commitsInRange[rangePositionBySha.get(finding.commitSha)!]!;
    rankedSuspects.push(
      buildSuspect(commit, STRENGTH_DETAILS[finding.strength], {
        reason: writeReason(finding),
        filePath: finding.filePath,
        lineNumber: finding.lineNumber,
        lineText: finding.lineText,
      }),
    );
  }

  for (const commit of input.commitsInRange) {
    if (suspectedShas.has(commit.sha)) continue;
    const firstChangedFile = [...(input.changedFilesByCommit.get(commit.sha) ?? [])].sort(compareStrings)[0] ?? "";
    rankedSuspects.push(
      buildSuspect(commit, TIMING_ONLY_DETAILS, {
        reason: "This commit shipped in this deploy, but nothing ties it to the error except timing.",
        filePath: firstChangedFile,
        lineNumber: null,
        lineText: null,
      }),
    );
  }

  const topSuspects = rankedSuspects.slice(0, MAX_SUSPECTS);
  if (topSuspects.length === 0 || topSuspects[0]!.confidence === "low") return { suspects: [], message: NO_STRONG_SUSPECT_MESSAGE };
  return { suspects: topSuspects, message: null };
}
