
import { timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "x-vika-token";

export interface GuardInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  token: string | undefined; // the X-Vika-Token header
  serverPort: number;
  expectedToken: string;
}

export type GuardDecision = { isAllowed: true } | { isAllowed: false; reason: string };

const isSameText = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

export function checkRequest(input: GuardInput): GuardDecision {
  const allowedHosts = [`localhost:${input.serverPort}`, `127.0.0.1:${input.serverPort}`];
  if (input.host === undefined || !allowedHosts.includes(input.host.toLowerCase())) {
    return { isAllowed: false, reason: "the dashboard only answers requests addressed to localhost" };
  }
  if (input.origin !== undefined && !allowedHosts.map((host) => `http://${host}`).includes(input.origin.toLowerCase())) {
    return { isAllowed: false, reason: "requests from other websites are refused" };
  }
  if (input.method !== "GET" && input.method !== "HEAD") {
    if (input.token === undefined || !isSameText(input.token, input.expectedToken)) {
      return { isAllowed: false, reason: "missing or wrong dashboard token; reload the page" };
    }
  }
  return { isAllowed: true };
}
