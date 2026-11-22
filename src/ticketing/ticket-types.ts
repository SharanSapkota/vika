// The shapes ticket creation works with. A TicketDraft is plain data: the
// tracker clients turn it into a Jira or Linear issue.
import type { Suspect } from "../suspect-attribution/suspect-types.js";

export type AssigneeSource = "author" | "codeowners" | "none";

// Who should get the ticket. With source "none" the ticket is created
// unassigned; name then still holds the suspect's author, for the description.
export interface SuggestedAssignee {
  name: string | null;
  email: string | null;
  source: AssigneeSource;
}

// Owners for a file from CODEOWNERS. Only emails can be matched to tracker
// users; GitHub handles (@alice, @org/team) are shown in the description.
export interface CodeOwners {
  emails: string[];
  handles: string[];
}

// One part of the ticket body: a heading and its lines. Lines starting with
// "- " are list items.
export interface BodySection {
  heading: string;
  lines: string[];
}

// One error group in the ticket, for later comments ("new group appeared").
export interface DraftGroup {
  fingerprint: string;
  headline: string;
  severity: "high" | "medium";
  occurrences: number;
}

// What choose-assignee needs, kept on the draft so create-ticket can make
// the final choice once the tracker has said which emails it knows.
export interface AssignmentFacts {
  topSuspect: Suspect | null;
  codeOwners: CodeOwners;
}

export interface TicketDraft {
  service: string;
  deploySha: string;
  dedupKey: string; // the deploy sha: one bad deploy, one ticket
  title: string;
  bodySections: BodySection[];
  labels: string[];
  regressionFingerprints: string[];
  totalOccurrences: number; // medium and high groups only, log-derived
  suggestedAssignee: SuggestedAssignee;
  groups: DraftGroup[];
  assignmentFacts: AssignmentFacts;
}
