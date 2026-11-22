import type { Frame } from "../log-parsing/log-entry-types.js";
import type { MinerState } from "./template-miner.js";

export const MAX_EXAMPLES = 3;
export const MAX_SOURCE_REFS = 3;

export interface Cluster {
  fingerprint: string;
  service: string;
  template: string;
  countsPerMinute: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  examples: string[];
  sourceRefs: string[];
  topFrames: Frame[];
  exceptionType?: string;
}

export interface ClusterResult {
  clusters: Cluster[];
  state: MinerState;
}
