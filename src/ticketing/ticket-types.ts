

import type { Suspect } from "../suspect-attribution/suspect-types.js";

export type AssigneeSource = "author" | "codeowners" | "none";



export interface SuggestedAssignee {
  name: string | null;
  email: string | null;
  source: AssigneeSource;
}



export interface CodeOwners {
  emails: string[];
  handles: string[];
}



export interface BodySection {
  heading: string;
  lines: string[];
}


export interface DraftGroup {
  fingerprint: string;
  headline: string;
  severity: "high" | "medium";
  occurrences: number;
}



export interface AssignmentFacts {
  topSuspect: Suspect | null;
  codeOwners: CodeOwners;
}

export interface TicketDraft {
  service: string;
  deploySha: string;
  dedupKey: string; 
  title: string;
  bodySections: BodySection[];
  labels: string[];
  regressionFingerprints: string[];
  totalOccurrences: number; 
  suggestedAssignee: SuggestedAssignee;
  groups: DraftGroup[];
  assignmentFacts: AssignmentFacts;
}
