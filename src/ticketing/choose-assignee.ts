// Who gets the ticket. Pure: the tracker lookups happen before this, and
// their answer comes in as isTrackerUser.
//
// Order (brief, CHANGES block):
//   1. the top suspect's author, by email, if the tracker knows that email,
//      unless the author is a bot or the email is a "noreply" address
//   2. else the first CODEOWNERS email owner of the suspect's file that the
//      tracker knows
//   3. else nobody: the ticket is unassigned, and the author's name stays
//      on the assignee so the description can mention it
import { isBotAuthor } from "../suspect-attribution/bot-authors.js";
import type { Suspect } from "../suspect-attribution/suspect-types.js";
import type { SuggestedAssignee } from "./ticket-types.js";

// GitHub's "12345+name@users.noreply.github.com", "noreply@...", "no-reply@...".
export function isNoReplyEmail(email: string): boolean {
  return /no-?reply/i.test(email);
}

export interface AssigneeChoiceInput {
  topSuspect: Suspect | null;
  codeOwnerEmails: string[];
  // Does the tracker have a user with this email? Before any lookup (to
  // show a suggestion), pass () => true.
  isTrackerUser: (email: string) => boolean;
}

export function chooseAssignee(input: AssigneeChoiceInput): SuggestedAssignee {
  const author = input.topSuspect?.author;
  const isAuthorUsable =
    author !== undefined &&
    author.email !== "" &&
    !input.topSuspect!.isBot &&
    !isBotAuthor(author.name, author.email) &&
    !isNoReplyEmail(author.email);
  if (isAuthorUsable && input.isTrackerUser(author.email)) return { name: author.name, email: author.email, source: "author" };

  const codeOwnerEmail = input.codeOwnerEmails.find((email) => !isNoReplyEmail(email) && input.isTrackerUser(email));
  if (codeOwnerEmail !== undefined) return { name: null, email: codeOwnerEmail, source: "codeowners" };

  return { name: author?.name ?? null, email: null, source: "none" };
}
