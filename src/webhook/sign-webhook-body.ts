


import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Vika-Signature";

export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}



export function isWebhookSignatureValid(body: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookBody(body, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
