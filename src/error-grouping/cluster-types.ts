// The shape of one error group (cluster) and what grouping returns.
import type { Frame } from "../log-parsing/log-entry-types.js";
import type { MinerState } from "./template-miner.js";

export const MAX_EXAMPLES = 3;
export const MAX_SOURCE_REFS = 3;

export interface Cluster {
  fingerprint: string;
  service: string;
  template: string;
  countsPerMinute: Record<string, number>; // "2026-03-06T14:04:00.000Z" -> count
  firstSeen: string; // ISO
  lastSeen: string; // ISO
  examples: string[]; // up to 3 different, redacted messages
  sourceRefs: string[]; // up to 3 different "file:line" from the top frame
  topFrames: Frame[]; // top frames of the first entry seen
  exceptionType?: string;
}

export interface ClusterResult {
  clusters: Cluster[];
  state: MinerState;
}
