import { createHash } from "node:crypto";
import type { Frame } from "../parse/types.js";
import { NORMALIZER_VERSION } from "./normalize.js";

export const FINGERPRINT_FRAMES = 3;

function shortHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

export function exceptionType(message: string): string | undefined {
  const m = /^([\w$.]*(?:Error|Exception))(?::|$)/m.exec(message);
  return m?.[1];
}

export function stackFingerprint(service: string, type: string | undefined, frames: Frame[]): string {
  const top = frames.slice(0, FINGERPRINT_FRAMES).map((f) => [f.file, f.fn ?? ""]);
  return shortHash([NORMALIZER_VERSION, service, "stack", type ?? "", top]);
}

export function messageFingerprint(service: string, normalizedMessage: string): string {
  return shortHash([NORMALIZER_VERSION, service, "message", normalizedMessage]);
}
