// Stable ids for error groups. The normalizer version is part of every
// fingerprint, so changing the normalizer never mixes old and new groups.
import { createHash } from "node:crypto";
import type { Frame } from "../log-parsing/log-entry-types.js";
import { NORMALIZER_VERSION } from "./normalize-message.js";

export const FINGERPRINT_FRAME_COUNT = 3;

function shortHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

// Line numbers are left out on purpose: the same crash should keep its
// fingerprint when unrelated lines above it move.
export function stackFingerprint(service: string, exceptionName: string | undefined, frames: Frame[]): string {
  const topFrames = frames.slice(0, FINGERPRINT_FRAME_COUNT).map((frame) => [frame.file, frame.fn ?? ""]);
  return shortHash([NORMALIZER_VERSION, service, "stack", exceptionName ?? "", topFrames]);
}

export function messageFingerprint(service: string, normalizedMessage: string): string {
  return shortHash([NORMALIZER_VERSION, service, "message", normalizedMessage]);
}
