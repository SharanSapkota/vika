

import { hideSecrets } from "../configuration/hide-secrets.js";
import type { BodySection, TicketDraft } from "./ticket-types.js";

export function renderMarkdown(sections: BodySection[]): string {
  return sections.map((section) => [`### ${section.heading}`, "", ...section.lines].join("\n")).join("\n\n");
}

export function renderPlainText(sections: BodySection[]): string {
  return sections.map((section) => [section.heading, ...section.lines].join("\n")).join("\n\n");
}



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
