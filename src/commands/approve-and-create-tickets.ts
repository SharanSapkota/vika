// A person approves every ticket before it is filed. For each draft this
// shows the title, assignee, top suspect and count, then asks:
//   Create ticket? [y]es / [n]o / [e]dit title
// "y" files it, "e" asks for a new title and then files it, anything else
// skips it. Without an interactive terminal nothing is ever filed.
// Input and output are passed in, so tests can answer the questions.
import type { CreateTicketOutcome } from "../ticketing/create-ticket.js";
import { describeAssignee, describeOutcome } from "../ticketing/describe-ticket-outcome.js";
import type { TicketDraft } from "../ticketing/ticket-types.js";

export const APPROVAL_QUESTION = "Create ticket? [y]es / [n]o / [e]dit title ";

export interface ApprovalConsole {
  isInteractive: boolean; // a person at a terminal who can answer
  write: (text: string) => void;
  ask: (question: string) => Promise<string>;
}

export interface ApprovalResult {
  draft: TicketDraft; // as filed (with an edited title, if it was edited)
  decision: "approved" | "skipped" | "not interactive";
  outcome: CreateTicketOutcome | null; // null when nothing was filed
}


function describeDraft(draft: TicketDraft, draftNumber: number, draftCount: number): string {
  const topSuspect = draft.assignmentFacts.topSuspect;
  const suspectText =
    topSuspect === null
      ? "none (no strong suspect in this deploy; may be external)"
      : `${topSuspect.prNumber === null ? `commit ${topSuspect.commitSha.slice(0, 7)}` : `PR #${topSuspect.prNumber}`} by ${topSuspect.author.name}, ` +
        `${topSuspect.lineNumber === null ? topSuspect.filePath : `${topSuspect.filePath}:${topSuspect.lineNumber}`}, confidence ${topSuspect.confidence}`;
  return [
    "",
    `Ticket draft ${draftNumber} of ${draftCount}`,
    `  Title:       ${draft.title}`,
    // A suggestion: the tracker confirms it when the ticket is filed.
    `  Assignee:    ${describeAssignee(draft.suggestedAssignee)}`,
    `  Top suspect: ${suspectText}`,
    `  Occurrences: ${draft.totalOccurrences} (log-derived)`,
    "",
  ].join("\n");
}

export async function approveAndCreateTickets(
  drafts: TicketDraft[],
  approvalConsole: ApprovalConsole,
  createTicket: (draft: TicketDraft) => Promise<CreateTicketOutcome>,
): Promise<ApprovalResult[]> {
  if (drafts.length === 0) {
    approvalConsole.write("\nNo tickets to file: no deploy has a medium or high regression.\n");
    return [];
  }
  if (!approvalConsole.isInteractive) {
    approvalConsole.write(
      `\n${drafts.length} ticket ${drafts.length === 1 ? "draft" : "drafts"} not filed: approving tickets needs an interactive terminal. ` +
        "Run vika report --create-tickets in a terminal.\n",
    );
    return drafts.map((draft) => ({ draft, decision: "not interactive", outcome: null }));
  }

  const results: ApprovalResult[] = [];
  for (const [draftIndex, originalDraft] of drafts.entries()) {
    let draft = originalDraft;
    approvalConsole.write(describeDraft(draft, draftIndex + 1, drafts.length));
    const answer = (await approvalConsole.ask(APPROVAL_QUESTION)).trim().toLowerCase();
    if (answer === "e") {
      const newTitle = (await approvalConsole.ask("New title: ")).trim();
      if (newTitle !== "") draft = { ...draft, title: newTitle };
    } else if (answer !== "y") {
      approvalConsole.write("Skipped.\n");
      results.push({ draft, decision: "skipped", outcome: null });
      continue;
    }
    const outcome = await createTicket(draft);
    approvalConsole.write(`${describeOutcome(outcome)}\n`);
    results.push({ draft, decision: "approved", outcome });
  }
  return results;
}
