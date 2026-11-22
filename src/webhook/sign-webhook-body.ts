// Signs a webhook body so the receiver can check it came from vika and was
// not changed: HMAC-SHA256 of the exact body bytes with the shared secret,
// sent as  X-Vika-Signature: sha256=<hex>  (the same style GitHub uses).
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Vika-Signature";

export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

// For receivers (and tests): does the signature match? Compares in constant
// time, so the comparison itself leaks nothing.
export function isWebhookSignatureValid(body: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookBody(body, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
