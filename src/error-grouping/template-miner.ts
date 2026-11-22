// Groups messages without a stack trace by template: messages with the same
// length and first token that mostly match share a group, and the tokens
// that differ become a wildcard.
import { messageFingerprint } from "./fingerprints.js";
import { NORMALIZER_VERSION } from "./normalize-message.js";

export const PREFIX_TOKEN_COUNT = 1;
export const SIMILARITY_THRESHOLD = 0.7;
export const WILDCARD = "<*>";

// Stored as JSON in the database (miner_state), so field names stay as they are.
export interface MinerGroup {
  fingerprint: string;
  service: string;
  tokens: string[]; // the template, split on whitespace
}

export interface MinerState {
  version: number; // NORMALIZER_VERSION the groups were made with
  groups: MinerGroup[];
}

export interface Miner {
  groups: MinerGroup[];
  tree: Map<string, MinerGroup[]>; // "service \0 length \0 prefix" -> groups
  byFingerprint: Map<string, MinerGroup>;
}

export function emptyState(): MinerState {
  return { version: NORMALIZER_VERSION, groups: [] };
}

export function tokenize(normalizedMessage: string): string[] {
  return normalizedMessage.split(/\s+/).filter((token) => token !== "");
}

function treeKey(service: string, tokens: string[]): string {
  return [service, String(tokens.length), ...tokens.slice(0, PREFIX_TOKEN_COUNT)].join("\0");
}

// State saved with another normalizer version is dropped: its templates
// were made from differently normalized messages.
export function importState(state: MinerState): Miner {
  const miner: Miner = { groups: [], tree: new Map(), byFingerprint: new Map() };
  if (state.version !== NORMALIZER_VERSION) return miner;
  for (const group of state.groups) addGroup(miner, { fingerprint: group.fingerprint, service: group.service, tokens: [...group.tokens] });
  return miner;
}

export function exportState(miner: Miner): MinerState {
  return {
    version: NORMALIZER_VERSION,
    groups: miner.groups.map((group) => ({ fingerprint: group.fingerprint, service: group.service, tokens: [...group.tokens] })),
  };
}

function addGroup(miner: Miner, group: MinerGroup): void {
  miner.groups.push(group);
  miner.byFingerprint.set(group.fingerprint, group);
  const key = treeKey(group.service, group.tokens);
  const groupsWithSameKey = miner.tree.get(key);
  if (groupsWithSameKey) groupsWithSameKey.push(group);
  else miner.tree.set(key, [group]);
}

// The share of positions where the template and the message have the same token.
function similarity(template: string[], tokens: string[]): number {
  let matchingTokenCount = 0;
  for (let position = 0; position < tokens.length; position++) if (template[position] === tokens[position]) matchingTokenCount++;
  return matchingTokenCount / tokens.length;
}

export function addMessage(miner: Miner, service: string, normalizedMessage: string): MinerGroup {
  const tokens = tokenize(normalizedMessage);

  let bestGroup: MinerGroup | undefined;
  let bestScore = -1;
  for (const group of miner.tree.get(treeKey(service, tokens)) ?? []) {
    const score = similarity(group.tokens, tokens);
    if (score > bestScore) {
      bestGroup = group;
      bestScore = score;
    }
  }

  if (bestGroup && bestScore >= SIMILARITY_THRESHOLD) {
    bestGroup.tokens = bestGroup.tokens.map((token, position) => (token === tokens[position] ? token : WILDCARD));
    return bestGroup;
  }

  const fingerprint = messageFingerprint(service, tokens.join(" "));
  const existing = miner.byFingerprint.get(fingerprint);
  if (existing) return existing;
  const group: MinerGroup = { fingerprint, service, tokens };
  addGroup(miner, group);
  return group;
}
