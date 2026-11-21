
import { exceptionType, FINGERPRINT_FRAMES, stackFingerprint } from "./cluster/fingerprint.js";
import { addMessage, emptyState, exportState, importState, tokenize, type MinerState } from "./cluster/miner.js";
import { normalize } from "./cluster/normalize.js";
import type { Frame, LogEntry } from "./parse/types.js";
import { redact } from "./redact.js";

export { NORMALIZER_VERSION, normalize } from "./cluster/normalize.js";
export { exceptionType, messageFingerprint, stackFingerprint } from "./cluster/fingerprint.js";
export { addMessage, emptyState, exportState, importState, type MinerState } from "./cluster/miner.js";

export const MAX_EXAMPLES = 3;
export const MAX_SOURCE_REFS = 3;

export interface Cluster {
  fingerprint: string;
  service: string;
  template: string;
  countsPerMinute: Record<string, number>; // "2026-03-06T14:04:00.000Z" -> count
  firstSeen: string; // ISO
  lastSeen: string; // ISO
  examples: string[]; // up to 3 different, redacted messages
  sourceRefs: string[]; // up to 3 different "file:line" from the top frame
  topFrames: Frame[]; // top frames of the first entry seen
  exceptionType?: string;
}

export interface ClusterResult {
  clusters: Cluster[];
  state: MinerState;
}

// Plain string order (not locale-aware), so output never depends on the machine.
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The start of the entry's minute, as ISO.
function minuteOf(timestamp: string): string {
  const d = new Date(Date.parse(timestamp));
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

interface Building {
  cluster: Cluster;
  counts: Map<string, number>;
  fromMiner: boolean; // template comes from the miner at the end
}

export function buildClusters(entries: LogEntry[], service: string, state?: MinerState): ClusterResult {
  const miner = importState(state ?? emptyState());
  const groups = new Map<string, Building>();

  for (const entry of entries) {
    const normalized = normalize(entry.message);
    const type = exceptionType(entry.message);
    const hasStack = entry.frames.length > 0;
    const fingerprint = hasStack ? stackFingerprint(service, type, entry.frames) : addMessage(miner, service, normalized).fingerprint;

    let group = groups.get(fingerprint);
    if (!group) {
      const cluster: Cluster = {
        fingerprint,
        service,
        template: tokenize(normalized).join(" "),
        countsPerMinute: {},
        firstSeen: entry.timestamp,
        lastSeen: entry.timestamp,
        examples: [],
        sourceRefs: [],
        topFrames: entry.frames.slice(0, FINGERPRINT_FRAMES).map((f) => ({ ...f })),
      };
      if (type !== undefined) cluster.exceptionType = type;
      group = { cluster, counts: new Map(), fromMiner: !hasStack };
      groups.set(fingerprint, group);
    }

    const c = group.cluster;
    const minute = minuteOf(entry.timestamp);
    group.counts.set(minute, (group.counts.get(minute) ?? 0) + 1);
    if (Date.parse(entry.timestamp) < Date.parse(c.firstSeen)) c.firstSeen = entry.timestamp;
    if (Date.parse(entry.timestamp) > Date.parse(c.lastSeen)) c.lastSeen = entry.timestamp;

    // Messages are already redacted by the parser; redact again to be safe.
    const example = redact(entry.message);
    if (c.examples.length < MAX_EXAMPLES && !c.examples.includes(example)) c.examples.push(example);

    if (entry.file !== undefined && entry.lineNumber !== undefined) {
      const ref = `${entry.file}:${entry.lineNumber}`;
      if (c.sourceRefs.length < MAX_SOURCE_REFS && !c.sourceRefs.includes(ref)) c.sourceRefs.push(ref);
    }
  }

  const clusters: Cluster[] = [];
  for (const { cluster, counts, fromMiner } of groups.values()) {
    // Miner groups show their current (possibly generalized) template.
    if (fromMiner) cluster.template = miner.byFingerprint.get(cluster.fingerprint)!.tokens.join(" ");
    cluster.countsPerMinute = Object.fromEntries([...counts.entries()].sort(([a], [b]) => byString(a, b)));
    clusters.push(cluster);
  }
  // Stable order: oldest group first, fingerprint breaks ties.
  clusters.sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen) || byString(a.fingerprint, b.fingerprint));

  return { clusters, state: exportState(miner) };
}
