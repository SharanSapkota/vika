// Plain-English sentences for who got a ticket and what happened when vika
// tried to file it. Shown in the terminal approval and on the dashboard. Pure.
import type { CreateTicketOutcome } from "./create-ticket.js";
import type { SuggestedAssignee } from "./ticket-types.js";

export function describeAssignee(assignee: SuggestedAssignee): string {
  if (assignee.source === "author") return `${assignee.name} <${assignee.email}> (the suspect's author)`;
  if (assignee.source === "codeowners") return `${assignee.email} (code owner of the suspect's file)`;
  return `nobody (unassigned; the suspect's author is ${assignee.name ?? "unknown"})`;
}

export function describeOutcome(outcome: CreateTicketOutcome): string {
  switch (outcome.status) {
    case "created":
      return `Created ${outcome.issueKey}: ${outcome.issueUrl} (assigned to ${describeAssignee(outcome.assignee)})`;
    case "commented":
      return `Updated ${outcome.issueKey} with a comment: ${outcome.issueUrl}`;
    case "already filed":
      return `Already filed as ${outcome.issueKey}, nothing new: ${outcome.issueUrl}`;
    case "found in tracker":
      return `Already in the tracker as ${outcome.issueKey} (remembered it): ${outcome.issueUrl}`;
    case "filed by another run":
      return `Filed by another run as ${outcome.issueKey}: ${outcome.message}`;
    default:
      return `Not filed: ${outcome.message}`;
  }
}
