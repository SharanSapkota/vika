

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
