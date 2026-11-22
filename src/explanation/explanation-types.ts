// The plain data the optional AI step passes between its parts.
import type { RedactionKind } from "../redaction/redaction-kinds.js";
import type { Suspect } from "../suspect-attribution/suspect-types.js";

// One stack frame, with its path already mapped into the repo when possible.
export interface ExplanationFrame {
  filePath: string;
  lineNumber: number;
  functionName: string | null;
}

// Only what the AI may see about the error: no raw log lines.
export interface ExplanationRegression {
  exceptionType: string | null;
  message: string; // the report headline: built from a stored, redacted example
  topFrames: ExplanationFrame[];
}

// The code change of one suspect, limited to the files that matter.
export interface SuspectDiff {
  commitSha: string;
  diffText: string | null; // null when it could not be read
  problem: string | null; // why diffText is null, in plain English
}

export interface ExplanationRequestInput {
  regression: ExplanationRegression;
  suspects: Suspect[]; // in vika's ranking order; only the first 3 are used
  suspectDiffs: SuspectDiff[];
  maxDiffLines: number;
  redactionKinds: readonly RedactionKind[];
  secrets: string[]; // masked out of every piece of text
}

export interface ExplanationRequest {
  promptText: string; // exactly what is sent as the message
  // Shown in the preview: diffs that were left out, and why.
  leftOutNotes: string[];
}

// What the AI said for one regression. null in the report when nothing was
// sent (no approval, no terminal) or the request failed.
export interface Explanation {
  model: string;
  answerText: string;
}
