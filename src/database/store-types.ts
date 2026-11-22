// The shapes the store saves and returns, and the Store interface itself.
// Kept apart from database-store.ts so other code can use these types
// without importing anything that talks to Postgres.
import type { Cluster } from "../error-grouping/cluster-types.js";
import type { MinerState } from "../error-grouping/template-miner.js";
import type { Frame } from "../log-parsing/log-entry-types.js";
import type { FileBookmark } from "../log-parsing/read-log-file.js";

export interface Bookmark {
  sourceKey: string;
  file?: FileBookmark;
  lastTimestamp?: string; // ISO: the newest log line read so far
  // ISO: the earliest log line of the first read. Saved once, never changed.
  firstReadAt?: string;
}

// A ticket vika filed in a tracker. dedupKey is the deploy sha: one bad
// deploy, one ticket.
export interface NewTicket {
  service: string;
  dedupKey: string;
  issueKey: string;
  issueUrl: string;
  trackerType: string;
  deploySha: string;
  fingerprints: string[];
  lastKnownCount: number;
}

export interface StoredTicket extends NewTicket {
  lastCommentedCount: number; // the count when vika filed it or last commented
  createdAt: string; // ISO, set by the database
  updatedAt: string; // ISO, set by the database
}

// One regression vika posts to the webhook, identified by service + deploy
// sha + fingerprint.
export interface WebhookEventKey {
  service: string;
  deploySha: string;
  fingerprint: string;
}

export type WebhookEventStatus = "pending" | "delivered" | "failed";

export interface StoredWebhookEvent extends WebhookEventKey {
  eventId: string;
  status: WebhookEventStatus;
  attempts: number;
}

// Where a service's log history starts and ends, across its log sources.
export interface LogHistory {
  historyStart: string | null; // ISO: the earliest firstReadAt
  lastLogTimestamp: string | null; // ISO: the newest lastTimestamp
}

export interface Batch {
  service: string;
  clusters: Cluster[];
  minerState: MinerState;
  bookmark: Bookmark;
}

export interface Deploy {
  service: string;
  sha: string;
  previousSha: string | null;
  time: string; // ISO
  source: string; // where we learned about it, e.g. "git", "file", "manual"
}

export interface StoredCluster {
  service: string;
  fingerprint: string;
  normalizerVersion: number;
  template: string;
  exceptionType?: string;
  topFrames: Frame[];
  examples: string[];
  sourceRefs: string[];
  firstSeen: string; // ISO
  lastSeen: string; // ISO
}

export interface StoreOptions {
  // Postgres schema to use instead of "public". Tests use a fresh one each.
  schema?: string;
}

export interface Store {
  saveBatch(batch: Batch): Promise<void>;
  getBookmark(service: string, sourceKey: string): Promise<Bookmark | undefined>;
  getMinerState(service: string): Promise<MinerState | undefined>;
  getCluster(service: string, fingerprint: string): Promise<StoredCluster | undefined>;
  getClusterCounts(service: string, fingerprint: string, fromTime: string, toTime: string): Promise<Record<string, number>>;
  getBaselineFingerprints(service: string, beforeTime: string, windowDays: number): Promise<string[]>;
  listClusters(service: string): Promise<StoredCluster[]>;
  // fingerprint -> { ISO minute -> count }, every minute ever counted.
  listClusterCounts(service: string): Promise<Record<string, Record<string, number>>>;
  getLogHistory(service: string): Promise<LogHistory>;
  saveDeploy(deploy: Deploy): Promise<boolean>;
  listDeploys(service: string): Promise<Deploy[]>;
  withRunLock<T>(service: string, work: () => Promise<T>): Promise<T | "busy">;
  findTicket(service: string, dedupKey: string): Promise<StoredTicket | undefined>;
  // false when a ticket with this key was already saved (e.g. by another run).
  saveTicket(ticket: NewTicket): Promise<boolean>;
  updateTicketCount(service: string, dedupKey: string, count: number): Promise<void>;
  // A comment was added at this count: sets both the known and the commented count.
  recordTicketComment(service: string, dedupKey: string, count: number): Promise<void>;
  updateTicketFingerprints(service: string, dedupKey: string, fingerprints: string[]): Promise<void>;
  findWebhookEvent(key: WebhookEventKey): Promise<StoredWebhookEvent | undefined>;
  // false when the event was already saved (ON CONFLICT DO NOTHING).
  saveWebhookEvent(key: WebhookEventKey, eventId: string): Promise<boolean>;
  recordWebhookAttempt(key: WebhookEventKey, status: "delivered" | "failed"): Promise<void>;
  // Deletes everything stored for one service (for `npm run demo:reset`).
  // Returns how many rows each table lost.
  deleteServiceData(service: string): Promise<Record<string, number>>;
  appliedMigrations(): Promise<string[]>;
  close(): Promise<void>;
}
