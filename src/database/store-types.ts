


import type { Cluster } from "../error-grouping/cluster-types.js";
import type { MinerState } from "../error-grouping/template-miner.js";
import type { Frame } from "../log-parsing/log-entry-types.js";
import type { FileBookmark } from "../log-parsing/read-log-file.js";

export interface Bookmark {
  sourceKey: string;
  file?: FileBookmark;
  lastTimestamp?: string; 
  
  firstReadAt?: string;
}



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
  lastCommentedCount: number; 
  createdAt: string; 
  updatedAt: string; 
}



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


export interface LogHistory {
  historyStart: string | null; 
  lastLogTimestamp: string | null; 
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
  time: string; 
  source: string; 
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
  firstSeen: string; 
  lastSeen: string; 
}

export interface StoreOptions {
  
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
  
  listClusterCounts(service: string): Promise<Record<string, Record<string, number>>>;
  getLogHistory(service: string): Promise<LogHistory>;
  saveDeploy(deploy: Deploy): Promise<boolean>;
  listDeploys(service: string): Promise<Deploy[]>;
  withRunLock<T>(service: string, work: () => Promise<T>): Promise<T | "busy">;
  findTicket(service: string, dedupKey: string): Promise<StoredTicket | undefined>;
  
  saveTicket(ticket: NewTicket): Promise<boolean>;
  updateTicketCount(service: string, dedupKey: string, count: number): Promise<void>;
  
  recordTicketComment(service: string, dedupKey: string, count: number): Promise<void>;
  updateTicketFingerprints(service: string, dedupKey: string, fingerprints: string[]): Promise<void>;
  findWebhookEvent(key: WebhookEventKey): Promise<StoredWebhookEvent | undefined>;
  
  saveWebhookEvent(key: WebhookEventKey, eventId: string): Promise<boolean>;
  recordWebhookAttempt(key: WebhookEventKey, status: "delivered" | "failed"): Promise<void>;
  
  
  deleteServiceData(service: string): Promise<Record<string, number>>;
  appliedMigrations(): Promise<string[]>;
  close(): Promise<void>;
}
