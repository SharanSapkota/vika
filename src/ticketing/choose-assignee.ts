









import { isBotAuthor } from "../suspect-attribution/bot-authors.js";
import type { Suspect } from "../suspect-attribution/suspect-types.js";
import type { SuggestedAssignee } from "./ticket-types.js";


export function isNoReplyEmail(email: string): boolean {
  return /no-?reply/i.test(email);
}

export interface AssigneeChoiceInput {
  topSuspect: Suspect | null;
  codeOwnerEmails: string[];
  
  
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
