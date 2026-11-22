import type { RangeCommit } from "../deploys/commits-in-range.js";
import type { Language } from "../log-parsing/languages.js";
import type { Frame } from "../log-parsing/log-entry-types.js";

export type Confidence = "high" | "medium" | "low";

export type EvidenceKind =
  | "blamed-line-changed"
  | "same-function-changed"
  | "call-chain-function-changed"
  | "file-changed"
  | "dependency-or-config-change"
  | "timing-only";

export interface Suspect {
  commitSha: string;
  prNumber: number | null;
  confidence: Confidence;
  evidenceKind: EvidenceKind;
  reason: string;
  filePath: string;
  lineNumber: number | null;
  lineText: string | null;
  author: { name: string; email: string };
  isInDeployRange: true;
  isBot: boolean;
}

export type PathMap = Record<string, string>;

export interface AttributionInput {
  repoPath: string;
  deploySha: string;
  previousSha: string | null;
  topFrames: Frame[];
  pathMap?: PathMap;
  language?: Language; 
  commitsInRange: RangeCommit[];
}

export interface AttributionResult {
  suspects: Suspect[];
  message: string | null;
}

export type FindingStrength =
  | "blamed-line"
  | "crash-input-line"
  | "crash-input-callee"
  | "same-function"
  | "lower-frame-function"
  | "file"
  | "dependency-or-config";

export type ChangedFileCategory = "lockfile" | "config file" | "migration";

export interface Finding {
  commitSha: string;
  strength: FindingStrength;
  frameIndex: number;
  filePath: string;
  lineNumber: number | null;
  lineText: string | null;
  functionName: string | null;
  calleeName: string | null;
  fileCategory: ChangedFileCategory | null;
}
