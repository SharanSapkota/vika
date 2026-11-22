// The comment vika adds to a ticket it already filed, when a later run
// finds a new error group on the same deploy or more occurrences. Pure.
import type { TicketDraft } from "./ticket-types.js";

export function buildTicketComment(draft: TicketDraft, newFingerprints: string[], previousCount: number): string {
  const lines = ["vika update (counts are log-derived):"];
  const newGroups = draft.groups.filter((group) => newFingerprints.includes(group.fingerprint));
  if (newGroups.length > 0) {
    lines.push(`${newGroups.length === 1 ? "A new error group" : `${newGroups.length} new error groups`} appeared after the same deploy:`);
    for (const group of newGroups) lines.push(`- ${group.headline} (${group.severity}, ${group.occurrences} occurrences, group ${group.fingerprint})`);
  }
  if (draft.totalOccurrences !== previousCount) {
    lines.push(`Occurrences since the deploy: ${draft.totalOccurrences} (was ${previousCount} when vika last wrote to this ticket).`);
  }
  return lines.join("\n");
}
