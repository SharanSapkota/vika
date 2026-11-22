// What the regression detector takes in and gives back.
import type { Cluster } from "../error-grouping/cluster-types.js";

export interface DetectOptions {
  baselineDays: number; // how far back the baseline window goes
  newWindowMinutes: number; // a new group must appear within this long after the deploy
  minCount: number; // fewer occurrences than this is noise
  spikeFactor: number; // a spike is at least this many times the baseline rate
  minBaselineHours: number; // less history than this: don't judge the deploy
  restoreQuietMinutes: number; // back at baseline for this long = restored
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  baselineDays: 7,
  newWindowMinutes: 30,
  minCount: 5,
  spikeFactor: 5,
  minBaselineHours: 24,
  restoreQuietMinutes: 30,
};

// A deploy (the store's Deploy fits). `service` is optional; if present and
// different from the service being checked, the deploy is ignored.
export interface DetectDeploy {
  sha: string;
  previousSha: string | null;
  time: string; // ISO
  service?: string;
}

// The parts of a cluster the detector needs (the cluster code's Cluster fits).
export type DetectCluster = Pick<Cluster, "fingerprint" | "firstSeen" | "lastSeen" | "countsPerMinute"> & { service?: string };

// fingerprint -> { ISO minute -> count }, as loaded from the store.
export type BaselineCounts = Record<string, Record<string, number>>;

export interface DetectInput {
  service: string;
  deploys: DetectDeploy[]; // oldest first
  clusters: DetectCluster[];
  // Older counts from the store. Cluster counts and baseline counts are two
  // views of the same stored data: if both have the same minute, the larger
  // number is used. May cover any time range; the window is cut here.
  baseline?: BaselineCounts;
  // When this service's log history starts (e.g. when vika began reading its
  // logs). Default: the earliest minute in any cluster or baseline count.
  historyStart?: string;
  // How far the data goes (e.g. the end of the last log read). Default: the
  // end of the latest minute in any count. Used for "did it stay quiet long
  // enough" and for the last deploy's window.
  dataEnd?: string;
  options?: Partial<DetectOptions>;
}

export type Severity = "high" | "medium" | "low";

export interface Regression {
  fingerprint: string;
  deploySha: string;
  kind: "new" | "spike";
  firstSeen: string; // ISO: first occurrence after the deploy
  occurrences: number; // from the deploy until the next deploy (or end of data)
  baselineRate: number; // per hour, before the deploy (0 for new groups)
  postRate: number; // per hour, from the deploy until the next deploy (or end of data)
  ambiguous: boolean; // another deploy happened shortly before this one
  severity: Severity;
  restoredAt: string | null; // ISO minute, or null if still ongoing in the data
}

export type DeployStatus =
  | "checked"
  | "insufficient_baseline" // less than minBaselineHours of history: nothing flagged
  | "starting_point"; // first deploy (no previous sha): nothing is blamed in it

export interface DeployVerdict {
  deploySha: string;
  time: string;
  status: DeployStatus;
  failed: boolean; // at least one regression of severity medium or high
}

export interface DetectResult {
  regressions: Regression[];
  deploys: DeployVerdict[];
}
