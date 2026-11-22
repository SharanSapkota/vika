// Turns a draft's body sections into Markdown (Linear) or plain text, and
// masks secrets in everything a ticket will show. Pure.
import { hideSecrets } from "../configuration/hide-secrets.js";
import type { BodySection, TicketDraft } from "./ticket-types.js";

export function renderMarkdown(sections: BodySection[]): string {
  return sections.map((section) => [`### ${section.heading}`, "", ...section.lines].join("\n")).join("\n\n");
}

export function renderPlainText(sections: BodySection[]): string {
  return sections.map((section) => [section.heading, ...section.lines].join("\n")).join("\n\n");
}

// The same masking as error messages, applied to the title and every line,
// in case a secret ever made it into a log example or a commit subject.
export function maskDraftSecrets(draft: TicketDraft, secrets: string[]): TicketDraft {
  return {
    ...draft,
    title: hideSecrets(draft.title, secrets),
    bodySections: draft.bodySections.map((section) => ({
      heading: hideSecrets(section.heading, secrets),
      lines: section.lines.map((line) => hideSecrets(line, secrets)),
    })),
  };
}
