import type { Cluster } from "../error-grouping/cluster-types.js";

export interface DetectOptions {
  baselineDays: number;
  newWindowMinutes: number;
  minCount: number;
  spikeFactor: number;
  minBaselineHours: number;
  restoreQuietMinutes: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  baselineDays: 7,
  newWindowMinutes: 30,
  minCount: 5,
  spikeFactor: 5,
  minBaselineHours: 24,
  restoreQuietMinutes: 30,
};

export interface DetectDeploy {
  sha: string;
  previousSha: string | null;
  time: string;
  service?: string;
}

export type DetectCluster = Pick<Cluster, "fingerprint" | "firstSeen" | "lastSeen" | "countsPerMinute"> & { service?: string };

export type BaselineCounts = Record<string, Record<string, number>>;

export interface DetectInput {
  service: string;
  deploys: DetectDeploy[];
  clusters: DetectCluster[];
  baseline?: BaselineCounts;
  historyStart?: string;
  dataEnd?: string;
  options?: Partial<DetectOptions>;
}

export type Severity = "high" | "medium" | "low";

export interface Regression {
  fingerprint: string;
  deploySha: string;
  kind: "new" | "spike";
  firstSeen: string;
  occurrences: number;
  baselineRate: number;
  postRate: number;
  ambiguous: boolean;
  severity: Severity;
  restoredAt: string | null;
}

export type DeployStatus =
  | "checked"
  | "insufficient_baseline"
  | "starting_point";

export interface DeployVerdict {
  deploySha: string;
  time: string;
  status: DeployStatus;
  failed: boolean;
}

export interface DetectResult {
  regressions: Regression[];
  deploys: DeployVerdict[];
}
