// The shapes suspect attribution takes in and gives back.
import type { RangeCommit } from "../deploys/commits-in-range.js";
import type { Frame } from "../log-parsing/log-entry-types.js";

export type Confidence = "high" | "medium" | "low";

export type EvidenceKind =
  | "blamed-line-changed" // the line that threw was changed in this deploy
  | "same-function-changed" // the function that threw was changed
  | "call-chain-function-changed" // a function the failing code depends on was changed
  | "file-changed" // a file in the stack trace was changed
  | "dependency-or-config-change" // a lockfile, config file or migration was changed
  | "timing-only"; // shipped in the deploy, nothing else ties it to the error

// One suspect commit. The author is the person who wrote the change, never
// the committer (who may only have merged or rebased it).
export interface Suspect {
  commitSha: string;
  prNumber: number | null;
  confidence: Confidence;
  evidenceKind: EvidenceKind;
  reason: string; // one plain sentence
  filePath: string;
  lineNumber: number | null;
  lineText: string | null;
  author: { name: string; email: string };
  isInDeployRange: true; // only commits in previousSha..deploySha are ever suspects
  isBot: boolean;
}

// Server path prefix -> repo path prefix, e.g. { "/app/src": "src" }, so
// stack frame paths from the running server match paths in the repo.
// This is the pathMap setting from vika.yaml, as is.
export type PathMap = Record<string, string>;

export interface AttributionInput {
  repoPath: string;
  deploySha: string;
  previousSha: string | null; // null = first deploy
  topFrames: Frame[]; // from the cluster, top frame first
  pathMap?: PathMap;
  commitsInRange: RangeCommit[]; // from listCommitsInRange
}

export interface AttributionResult {
  suspects: Suspect[]; // at most 3, strongest first
  message: string | null; // set when there are no suspects, to say why
}

// What a finding is, from strongest to weakest. The scorer turns each into
// an evidence kind, a confidence and a rank.
export type FindingStrength =
  | "blamed-line" // the top frame's line was changed
  | "crash-input-line" // a line that sets a value the top frame's line reads was changed
  | "crash-input-callee" // a function whose return value the top frame's line reads was changed
  | "same-function" // the top frame's function was changed somewhere else
  | "lower-frame-function" // a function lower in the stack trace was changed
  | "file" // a file in the stack trace was changed
  | "dependency-or-config"; // a lockfile, config file or migration was changed

export type ChangedFileCategory = "lockfile" | "config file" | "migration";

// One piece of evidence against one commit, as found by the git readers.
export interface Finding {
  commitSha: string;
  strength: FindingStrength;
  frameIndex: number; // which stack frame it came from (lower = closer to the error)
  filePath: string;
  lineNumber: number | null;
  lineText: string | null;
  functionName: string | null; // the stack frame's function, if known
  calleeName: string | null; // for "crash-input-callee": the changed function
  fileCategory: ChangedFileCategory | null; // for "dependency-or-config"
}
