

import type { TicketDraft } from "../ticketing/ticket-types.js";



export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export interface TrackerUser {
  id: string; 
  name: string;
}

export interface TrackerIssue {
  issueKey: string; 
  issueUrl: string;
}

export interface TicketTracker {
  trackerType: "jira" | "linear";
  findUserByEmail(email: string): Promise<TrackerUser | undefined>;
  createIssue(draft: TicketDraft, assigneeId?: string): Promise<TrackerIssue>;
  addComment(issueKey: string, text: string): Promise<void>;
  findIssueByLabel(label: string): Promise<TrackerIssue | undefined>;
  
  checkCredentials(): Promise<{ name: string }>;
}


export const TRACKER_TIMEOUT_MS = 15_000;
