// Turns findings into ranked suspects. Pure: plain data in, plain data out.
//
// Ranking, strongest first:
//   1. the line that threw was changed                         high
//   2. a line feeding the failing line was changed             high
//   3. a function whose result the failing line reads changed  high
//   4. the function that threw was changed elsewhere           medium
//   5. a function lower in the stack trace was changed         medium
//   6. a file in the stack trace was changed                   medium
//   7. a lockfile, config file or migration was changed        medium
//   8. shipped in the deploy, nothing else                     low
// 2 and 3 sit above 4 because a change to where a failing value comes from
// explains the error better than an unrelated edit elsewhere in the same
// function (the "indirect" bug: getUser() starts returning null, and the
// error shows up in its caller).
import type { RangeCommit } from "../deploys/commits-in-range.js";
import { extractPrNumber } from "../deploys/pull-request-number.js";
import { isBotAuthor } from "./bot-authors.js";
import type { AttributionResult, Confidence, EvidenceKind, Finding, FindingStrength, Suspect } from "./suspect-types.js";

export const MAX_SUSPECTS = 3;
export const NO_STRONG_SUSPECT_MESSAGE = "no strong suspect in this deploy; may be external";

interface StrengthDetails {
  rank: number; // higher = stronger
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
  changedFilesByCommit: Map<string, string[]>; // for timing-only suspects' file
}

// "createOrder()" when the function is known, otherwise "the code".
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

// Plain string order (not locale-aware), so output never depends on the machine.
const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function scoreSuspects(input: ScoreInput): AttributionResult {
  const rangePositionBySha = new Map(input.commitsInRange.map((commit, rangePosition) => [commit.sha, rangePosition]));

  // Only commits the deploy shipped can be suspects: a blame that points
  // before the range never counts.
  const findingsInRange = input.findings.filter((finding) => rangePositionBySha.has(finding.commitSha));

  // Strongest first. Ties: closer to the top of the stack, then the order
  // the deploy shipped the commits in, then file and line, so the result
  // never depends on the order findings were collected in.
  findingsInRange.sort(
    (left, right) =>
      STRENGTH_DETAILS[right.strength].rank - STRENGTH_DETAILS[left.strength].rank ||
      left.frameIndex - right.frameIndex ||
      rangePositionBySha.get(left.commitSha)! - rangePositionBySha.get(right.commitSha)! ||
      compareStrings(left.filePath, right.filePath) ||
      (left.lineNumber ?? Infinity) - (right.lineNumber ?? Infinity),
  );

  // One suspect per commit, from its strongest finding. The findings are
  // sorted, so the suspects come out strongest first.
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

  // Every other commit in the deploy is a timing-only suspect, after all the
  // others, in the order the deploy shipped them.
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
