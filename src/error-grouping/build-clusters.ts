// Groups parsed log entries into clusters: entries with a stack trace are
// grouped by their top frames, the rest by message template (the miner).
//
// Grouping always works on FULLY redacted text, whatever vika.yaml's
// `redact` list says. Otherwise turning a kind off (say, emails) would
// change templates and fingerprints, and old errors would suddenly look like
// new groups, maybe right after a deploy. The `redact` list only decides
// what the stored examples and frames keep.
import type { Frame, LogEntry } from "../log-parsing/log-entry-types.js";
import { redact } from "../redaction/redact-sensitive-text.js";
import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import { MAX_EXAMPLES, MAX_SOURCE_REFS, type Cluster, type ClusterResult } from "./cluster-types.js";
import { readExceptionType } from "./exception-type.js";
import { FINGERPRINT_FRAME_COUNT, stackFingerprint } from "./fingerprints.js";
import { normalize } from "./normalize-message.js";
import { addMessage, emptyState, exportState, importState, tokenize, type MinerState } from "./template-miner.js";

// Plain string order (not locale-aware), so output never depends on the machine.
const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

// The start of the entry's minute, as ISO.
function minuteStartOf(timestamp: string): string {
  const minuteStart = new Date(Date.parse(timestamp));
  minuteStart.setUTCSeconds(0, 0);
  return minuteStart.toISOString();
}

interface ClusterInProgress {
  cluster: Cluster;
  countsPerMinute: Map<string, number>;
  isTemplateFromMiner: boolean; // template comes from the miner at the end
}

// Frames as grouping sees them: every kind redacted.
const redactFramesFully = (frames: Frame[]): Frame[] =>
  frames.map((frame) => (frame.fn === undefined ? { file: redact(frame.file), line: frame.line } : { file: redact(frame.file), line: frame.line, fn: redact(frame.fn) }));

export function buildClusters(
  entries: LogEntry[],
  service: string,
  minerState?: MinerState,
  redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS,
): ClusterResult {
  const miner = importState(minerState ?? emptyState());
  const clustersInProgress = new Map<string, ClusterInProgress>();

  for (const entry of entries) {
    const normalizedMessage = normalize(redact(entry.message));
    const exceptionName = readExceptionType(entry.message);
    const hasStackTrace = entry.frames.length > 0;
    const fingerprint = hasStackTrace
      ? stackFingerprint(service, exceptionName, redactFramesFully(entry.frames))
      : addMessage(miner, service, normalizedMessage).fingerprint;

    let inProgress = clustersInProgress.get(fingerprint);
    if (!inProgress) {
      const newCluster: Cluster = {
        fingerprint,
        service,
        template: tokenize(normalizedMessage).join(" "),
        countsPerMinute: {},
        firstSeen: entry.timestamp,
        lastSeen: entry.timestamp,
        examples: [],
        sourceRefs: [],
        topFrames: entry.frames.slice(0, FINGERPRINT_FRAME_COUNT).map((frame) => ({ ...frame })),
      };
      if (exceptionName !== undefined) newCluster.exceptionType = exceptionName;
      inProgress = { cluster: newCluster, countsPerMinute: new Map(), isTemplateFromMiner: !hasStackTrace };
      clustersInProgress.set(fingerprint, inProgress);
    }

    const cluster = inProgress.cluster;
    const minute = minuteStartOf(entry.timestamp);
    inProgress.countsPerMinute.set(minute, (inProgress.countsPerMinute.get(minute) ?? 0) + 1);
    if (Date.parse(entry.timestamp) < Date.parse(cluster.firstSeen)) cluster.firstSeen = entry.timestamp;
    if (Date.parse(entry.timestamp) > Date.parse(cluster.lastSeen)) cluster.lastSeen = entry.timestamp;

    // Messages are already redacted by the parser; redact again (with the
    // same kinds) to be safe.
    const example = redact(entry.message, redactionKinds);
    if (cluster.examples.length < MAX_EXAMPLES && !cluster.examples.includes(example)) cluster.examples.push(example);

    if (entry.file !== undefined && entry.lineNumber !== undefined) {
      const sourceReference = `${entry.file}:${entry.lineNumber}`;
      if (cluster.sourceRefs.length < MAX_SOURCE_REFS && !cluster.sourceRefs.includes(sourceReference)) {
        cluster.sourceRefs.push(sourceReference);
      }
    }
  }

  const clusters: Cluster[] = [];
  for (const { cluster, countsPerMinute, isTemplateFromMiner } of clustersInProgress.values()) {
    // Miner groups show their current (possibly generalized) template.
    if (isTemplateFromMiner) cluster.template = miner.byFingerprint.get(cluster.fingerprint)!.tokens.join(" ");
    cluster.countsPerMinute = Object.fromEntries(
      [...countsPerMinute.entries()].sort(([leftMinute], [rightMinute]) => compareStrings(leftMinute, rightMinute)),
    );
    clusters.push(cluster);
  }
  // Stable order: oldest group first, fingerprint breaks ties.
  clusters.sort(
    (left, right) => Date.parse(left.firstSeen) - Date.parse(right.firstSeen) || compareStrings(left.fingerprint, right.fingerprint),
  );

  return { clusters, state: exportState(miner) };
}
