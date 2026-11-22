import { messageFingerprint } from "./fingerprints.js";
import { NORMALIZER_VERSION } from "./normalize-message.js";

export const PREFIX_TOKEN_COUNT = 1;
export const SIMILARITY_THRESHOLD = 0.7;
export const WILDCARD = "<*>";

export interface MinerGroup {
  fingerprint: string;
  service: string;
  tokens: string[];
}

export interface MinerState {
  version: number;
  groups: MinerGroup[];
}

export interface Miner {
  groups: MinerGroup[];
  tree: Map<string, MinerGroup[]>;
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
