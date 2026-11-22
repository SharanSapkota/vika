// One ticket draft for one bad deploy. Pure.
//
// All medium and high regressions of the deploy go into ONE draft (one bad
// deploy, one ticket); low ones are only counted. Suspects from all the
// groups are merged by commit: the strongest one is shown in full, the
// others (up to 5 suspects in total) under "Also changed in this deploy".
// Only stored, redacted examples ever go into the text, never raw log lines.
import type { StoredCluster } from "../database/store-types.js";
import type { ReportRegression } from "../reporting/report-types.js";
import type { Confidence, Suspect } from "../suspect-attribution/suspect-types.js";
import { chooseAssignee } from "./choose-assignee.js";
import type { AssignmentFacts, BodySection, CodeOwners, DraftGroup, SuggestedAssignee, TicketDraft } from "./ticket-types.js";

export const AUTO_LABEL = "auto-vika";
export const MAX_SUSPECTS_IN_TICKET = 5;
export const MAX_EXAMPLES_PER_GROUP = 3;
export const ASSIGNMENT_HEADING = "Assignment";
const SHORT_SHA_LENGTH = 7;
const LABEL_SHA_LENGTH = 12;
const MAX_EXAMPLE_LENGTH = 300;

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

// The label that marks every ticket for one deploy. Also how a ticket is
// found again in the tracker if vika's own database was wiped.
export function makeDeployLabel(deploySha: string): string {
  return `deploy-${deploySha.slice(0, LABEL_SHA_LENGTH)}`;
}

export interface TicketDraftInput {
  serviceName: string;
  deploySha: string;
  deployTime: string | null;
  regressions: ReportRegression[]; // every regression the detector put on this deploy
  clusters: StoredCluster[]; // for examples, log sources and last seen
  codeOwners: CodeOwners; // owners of the top suspect's file
}

const isListed = (regression: ReportRegression) => regression.severity !== "low";
const shortSha = (sha: string) => sha.slice(0, SHORT_SHA_LENGTH);

function sortGroups(regressions: ReportRegression[]): ReportRegression[] {
  return [...regressions].sort(
    (left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      right.occurrences - left.occurrences ||
      (left.fingerprint < right.fingerprint ? -1 : 1),
  );
}

// The suspects of the listed groups, one per commit, strongest first.
// Within the same confidence, the order of the groups (worst first) decides.
export function rankDraftSuspects(regressions: ReportRegression[]): Suspect[] {
  const suspectsByCommit = new Map<string, Suspect>();
  for (const regression of sortGroups(regressions.filter(isListed))) {
    for (const suspect of regression.suspects) {
      const known = suspectsByCommit.get(suspect.commitSha);
      if (known === undefined || CONFIDENCE_ORDER[suspect.confidence] < CONFIDENCE_ORDER[known.confidence]) {
        suspectsByCommit.set(suspect.commitSha, suspect);
      }
    }
  }
  // Array.sort is stable, so equal confidences keep the group order above.
  return [...suspectsByCommit.values()].sort((left, right) => CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence]);
}

function describeSuspectLocation(suspect: Suspect): string {
  if (suspect.filePath === "") return "(no file)";
  return suspect.lineNumber === null ? suspect.filePath : `${suspect.filePath}:${suspect.lineNumber}`;
}

function describePullRequest(suspect: Suspect): string {
  return suspect.prNumber === null ? `commit ${suspect.commitSha}` : `PR #${suspect.prNumber}, commit ${suspect.commitSha}`;
}

// The text of the "Assignment" section for a given assignee.
export function describeAssignment(assignee: SuggestedAssignee, facts: AssignmentFacts): BodySection {
  const lines: string[] = [];
  const author = facts.topSuspect?.author;
  const authorText = author === undefined ? "unknown" : author.name;
  const suspectFile = facts.topSuspect?.filePath ?? "";
  if (assignee.source === "author") {
    lines.push(`Assigned to the suspect's author, ${assignee.name} <${assignee.email}>.`);
  } else if (assignee.source === "codeowners") {
    lines.push(`Assigned to a code owner of ${suspectFile}: ${assignee.email}. The suspect's author is ${authorText}.`);
  } else {
    lines.push(`Unassigned: no tracker user matched the suspect's author or the code owners. The suspect's author is ${authorText}.`);
  }
  if (facts.codeOwners.handles.length > 0) lines.push(`Code owners: ${facts.codeOwners.handles.join(", ")}`);
  return { heading: ASSIGNMENT_HEADING, lines };
}

// The draft with a final assignee, and the description to match.
export function applyAssignee(draft: TicketDraft, assignee: SuggestedAssignee): TicketDraft {
  return {
    ...draft,
    suggestedAssignee: assignee,
    bodySections: draft.bodySections.map((section) =>
      section.heading === ASSIGNMENT_HEADING ? describeAssignment(assignee, draft.assignmentFacts) : section,
    ),
  };
}

function writeGroupSection(regression: ReportRegression, cluster: StoredCluster | undefined): BodySection {
  const lines = [
    `Severity: ${regression.severity}; ${regression.kind === "new" ? "new error" : "spike in an existing error"}`,
    `Occurrences since the deploy: ${regression.occurrences} (log-derived)`,
    `First seen: ${regression.firstSeen}; last seen: ${cluster?.lastSeen ?? "unknown"}`,
  ];
  if (cluster !== undefined && cluster.sourceRefs.length > 0) {
    lines.push("Log sources (file:line from the stack trace):", ...cluster.sourceRefs.map((sourceRef) => `- ${sourceRef}`));
  }
  const examples = (cluster?.examples ?? []).slice(0, MAX_EXAMPLES_PER_GROUP);
  if (examples.length > 0) {
    lines.push("Examples (redacted):");
    for (const example of examples) {
      const oneLine = example.split("\n").map((part) => part.trim()).join(" | ");
      lines.push(`- ${oneLine.length > MAX_EXAMPLE_LENGTH ? `${oneLine.slice(0, MAX_EXAMPLE_LENGTH - 3)}...` : oneLine}`);
    }
  }
  return { heading: `Error group ${regression.fingerprint}: ${regression.headline}`, lines };
}

// Undefined when the deploy has no medium or high regression: no ticket.
export function buildTicketDraft(input: TicketDraftInput): TicketDraft | undefined {
  const listedRegressions = sortGroups(input.regressions.filter(isListed));
  if (listedRegressions.length === 0) return undefined;
  const lowCount = input.regressions.length - listedRegressions.length;
  const clustersByFingerprint = new Map(input.clusters.map((cluster) => [cluster.fingerprint, cluster]));
  const listedClusters = listedRegressions.map((regression) => clustersByFingerprint.get(regression.fingerprint));

  const rankedSuspects = rankDraftSuspects(listedRegressions).slice(0, MAX_SUSPECTS_IN_TICKET);
  const topSuspect = rankedSuspects[0] ?? null;
  const totalOccurrences = listedRegressions.reduce((total, regression) => total + regression.occurrences, 0);
  const firstSeen = listedRegressions.map((regression) => regression.firstSeen).sort()[0]!;
  const lastSeenTimes = listedClusters.flatMap((cluster) => (cluster === undefined ? [] : [cluster.lastSeen])).sort();

  const summaryLines = [
    `Service: ${input.serviceName}`,
    `Deploy: ${input.deploySha}${input.deployTime === null ? "" : ` (live at ${input.deployTime})`}`,
    `Error groups: ${listedRegressions.length} new or spiking (medium or high severity)`,
    `Occurrences since the deploy: ${totalOccurrences} (log-derived)`,
    `First seen: ${firstSeen}; last seen: ${lastSeenTimes.at(-1) ?? "unknown"}`,
  ];
  if (lowCount > 0) summaryLines.push(`${lowCount} low-severity ${lowCount === 1 ? "group" : "groups"} not listed`);

  const sections: BodySection[] = [{ heading: "Summary", lines: summaryLines }];
  if (topSuspect === null) {
    const message = listedRegressions.find((regression) => regression.suspectMessage !== null)?.suspectMessage;
    sections.push({ heading: "Top suspect", lines: [`None: ${message ?? "no strong suspect in this deploy; may be external"}.`] });
  } else {
    const topLines = [
      `${describePullRequest(topSuspect)}, by ${topSuspect.author.name} <${topSuspect.author.email}>${topSuspect.isBot ? " (a bot)" : ""}`,
      `File: ${describeSuspectLocation(topSuspect)}`,
    ];
    if (topSuspect.lineText !== null) topLines.push(`Line: ${topSuspect.lineText.trim()}`);
    topLines.push(`Confidence: ${topSuspect.confidence} (evidence: ${topSuspect.evidenceKind})`, `Why: ${topSuspect.reason}`);
    sections.push({ heading: "Top suspect", lines: topLines });
  }
  const otherSuspects = rankedSuspects.slice(1);
  if (otherSuspects.length > 0) {
    sections.push({
      heading: "Also changed in this deploy",
      lines: otherSuspects.map(
        (suspect) =>
          `- ${describePullRequest(suspect)} by ${suspect.author.name}: ${describeSuspectLocation(suspect)}; ` +
          `confidence ${suspect.confidence} (${suspect.evidenceKind}). Why: ${suspect.reason}`,
      ),
    });
  }
  listedRegressions.forEach((regression, groupIndex) => sections.push(writeGroupSection(regression, listedClusters[groupIndex])));

  const assignmentFacts: AssignmentFacts = { topSuspect, codeOwners: input.codeOwners };
  // Before the tracker is asked, suggest as if every email were a tracker
  // user; create-ticket makes the final choice.
  const suggestedAssignee = chooseAssignee({ topSuspect, codeOwnerEmails: input.codeOwners.emails, isTrackerUser: () => true });
  sections.push(describeAssignment(suggestedAssignee, assignmentFacts));
  sections.push({
    heading: "About this ticket",
    lines: [
      "Counts and times are log-derived: they come from the service's logs, not from incident records.",
      'Filed automatically after a person approved it. A "suspect" is a likely cause, not a certain one.',
    ],
  });

  const groupCountText = listedRegressions.length === 1 ? "1 error regression" : `${listedRegressions.length} error regressions`;
  const suspectText = topSuspect === null ? "" : ` (suspect: ${topSuspect.prNumber === null ? `commit ${shortSha(topSuspect.commitSha)}` : `PR #${topSuspect.prNumber}`})`;
  const groups: DraftGroup[] = listedRegressions.map((regression) => ({
    fingerprint: regression.fingerprint,
    headline: regression.headline,
    severity: regression.severity as "high" | "medium",
    occurrences: regression.occurrences,
  }));

  return {
    service: input.serviceName,
    deploySha: input.deploySha,
    dedupKey: input.deploySha,
    title: `${input.serviceName}: ${groupCountText} after deploy ${shortSha(input.deploySha)}${suspectText}`,
    bodySections: sections,
    labels: [AUTO_LABEL, `service-${input.serviceName}`, makeDeployLabel(input.deploySha), ...groups.map((group) => `fp-${group.fingerprint}`)],
    regressionFingerprints: groups.map((group) => group.fingerprint),
    totalOccurrences,
    suggestedAssignee,
    groups,
    assignmentFacts,
  };
}
