// What every ticket tracker client offers. create-ticket only talks to this
// interface, so it never knows whether it is filing in Jira or Linear.
import type { TicketDraft } from "../ticketing/ticket-types.js";

// The same shape as the global fetch; tests pass a fake one, so they never
// touch the network.
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export interface TrackerUser {
  id: string; // Jira accountId, Linear user id
  name: string;
}

export interface TrackerIssue {
  issueKey: string; // "OPS-123", "ENG-45"
  issueUrl: string;
}

export interface TicketTracker {
  trackerType: "jira" | "linear";
  findUserByEmail(email: string): Promise<TrackerUser | undefined>;
  createIssue(draft: TicketDraft, assigneeId?: string): Promise<TrackerIssue>;
  addComment(issueKey: string, text: string): Promise<void>;
  findIssueByLabel(label: string): Promise<TrackerIssue | undefined>;
  // One cheap authenticated call (for `vika doctor`): who the credentials log in as.
  checkCredentials(): Promise<{ name: string }>;
}

// Every request to a tracker gives up after this long.
export const TRACKER_TIMEOUT_MS = 15_000;
