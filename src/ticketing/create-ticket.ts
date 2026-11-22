
















import type { Store } from "../database/store-types.js";
import type { TicketTracker, TrackerUser } from "../ticket-trackers/tracker-types.js";
import { applyAssignee, makeDeployLabel } from "./build-ticket-draft.js";
import { buildTicketComment } from "./build-ticket-comment.js";
import { chooseAssignee } from "./choose-assignee.js";
import { hideSecrets } from "../configuration/hide-secrets.js";
import { maskDraftSecrets } from "./render-ticket-text.js";
import type { SuggestedAssignee, TicketDraft } from "./ticket-types.js";

export type CreateTicketOutcome =
  | { status: "created"; issueKey: string; issueUrl: string; assignee: SuggestedAssignee }
  | { status: "commented"; issueKey: string; issueUrl: string; newFingerprints: string[] }
  | { status: "already filed"; issueKey: string; issueUrl: string }
  | { status: "found in tracker"; issueKey: string; issueUrl: string } 
  | { status: "filed by another run"; issueKey: string; issueUrl: string; message: string }
  | { status: "busy"; message: string }
  | { status: "no tracker configured"; message: string }
  | { status: "failed"; message: string };

export interface CreateTicketInput {
  store: Store;
  tracker: TicketTracker | null; 
  draft: TicketDraft;
  secrets: string[]; 
}



async function lookUpAssigneeCandidates(tracker: TicketTracker, draft: TicketDraft): Promise<Map<string, TrackerUser>> {
  const candidateEmails = [draft.assignmentFacts.topSuspect?.author.email ?? "", ...draft.assignmentFacts.codeOwners.emails];
  const usersByEmail = new Map<string, TrackerUser>();
  for (const email of new Set(candidateEmails.filter((candidate) => candidate !== ""))) {
    const user = await tracker.findUserByEmail(email);
    if (user !== undefined) usersByEmail.set(email, user);
  }
  return usersByEmail;
}

async function fileTicket(store: Store, tracker: TicketTracker, draft: TicketDraft, secrets: string[]): Promise<CreateTicketOutcome> {
  
  const existing = await store.findTicket(draft.service, draft.dedupKey);
  if (existing !== undefined) {
    const newFingerprints = draft.regressionFingerprints.filter((fingerprint) => !existing.fingerprints.includes(fingerprint));
    
    
    
    const hasDoubled = draft.totalOccurrences > existing.lastCommentedCount && draft.totalOccurrences >= 2 * existing.lastCommentedCount;
    if (newFingerprints.length === 0 && !hasDoubled) {
      
      if (draft.totalOccurrences > existing.lastKnownCount) await store.updateTicketCount(draft.service, draft.dedupKey, draft.totalOccurrences);
      return { status: "already filed", issueKey: existing.issueKey, issueUrl: existing.issueUrl };
    }
    await tracker.addComment(existing.issueKey, hideSecrets(buildTicketComment(draft, newFingerprints, existing.lastCommentedCount), secrets));
    if (newFingerprints.length > 0) await store.updateTicketFingerprints(draft.service, draft.dedupKey, [...existing.fingerprints, ...newFingerprints]);
    await store.recordTicketComment(draft.service, draft.dedupKey, draft.totalOccurrences);
    return { status: "commented", issueKey: existing.issueKey, issueUrl: existing.issueUrl, newFingerprints };
  }

  const ticketRow = {
    service: draft.service,
    dedupKey: draft.dedupKey,
    trackerType: tracker.trackerType,
    deploySha: draft.deploySha,
    fingerprints: draft.regressionFingerprints,
    lastKnownCount: draft.totalOccurrences,
  };

  
  const issueInTracker = await tracker.findIssueByLabel(makeDeployLabel(draft.deploySha));
  if (issueInTracker !== undefined) {
    await store.saveTicket({ ...ticketRow, ...issueInTracker });
    return { status: "found in tracker", ...issueInTracker };
  }

  
  const usersByEmail = await lookUpAssigneeCandidates(tracker, draft);
  const assignee = chooseAssignee({
    topSuspect: draft.assignmentFacts.topSuspect,
    codeOwnerEmails: draft.assignmentFacts.codeOwners.emails,
    isTrackerUser: (email) => usersByEmail.has(email),
  });
  const finalDraft = maskDraftSecrets(applyAssignee(draft, assignee), secrets);
  const assigneeId = assignee.email === null ? undefined : usersByEmail.get(assignee.email)?.id;
  const createdIssue = await tracker.createIssue(finalDraft, assigneeId);
  const isSaved = await store.saveTicket({ ...ticketRow, ...createdIssue });
  if (!isSaved) {
    
    
    const other = await store.findTicket(draft.service, draft.dedupKey);
    return {
      status: "filed by another run",
      issueKey: other?.issueKey ?? createdIssue.issueKey,
      issueUrl: other?.issueUrl ?? createdIssue.issueUrl,
      message: `another vika run filed this deploy first; ${createdIssue.issueKey} is a duplicate and can be closed`,
    };
  }
  return { status: "created", ...createdIssue, assignee };
}

export async function createTicket(input: CreateTicketInput): Promise<CreateTicketOutcome> {
  if (input.tracker === null) return { status: "no tracker configured", message: 'tracker.type is "none" in vika.yaml, so no ticket was filed' };
  const tracker = input.tracker;
  try {
    const lockResult = await input.store.withRunLock(input.draft.service, () => fileTicket(input.store, tracker, input.draft, input.secrets));
    if (lockResult === "busy") {
      return { status: "busy", message: `another vika run is working on service "${input.draft.service}" right now; no ticket was filed` };
    }
    return lockResult;
  } catch (error) {
    return { status: "failed", message: hideSecrets(error instanceof Error ? error.message : String(error), input.secrets) };
  }
}
