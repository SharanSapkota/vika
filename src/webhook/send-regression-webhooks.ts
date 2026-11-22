// Posts each new regression to the configured webhook, once. Used by
// `vika run` after the report is built.
//
// - Never delivered twice: a regression is recorded in webhook_events before
//   the first attempt, and once "delivered" it is never sent again.
// - No retry loop: one attempt per regression per run. A failed delivery is
//   tried once more on the next run.
// - Never fails the run: problems come back as plain-English warnings.
// - Every request has a timeout. Warnings name only the webhook's host,
//   because webhook URLs often carry a token in their path.
// - Runs under each service's run lock, so two overlapping runs can't both
//   send the same regression.
import type { Store, WebhookEventKey } from "../database/store-types.js";
import type { Report } from "../reporting/report-types.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";
import { buildWebhookPayload } from "./build-webhook-payload.js";
import { REGRESSION_DETECTED_EVENT } from "./webhook-payload-schema.js";
import { SIGNATURE_HEADER, signWebhookBody } from "./sign-webhook-body.js";

export const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookSendInput {
  store: Store;
  webhook: { url: string; secret: string | null };
  report: Report;
  fetchFunction: FetchFunction;
  timeoutMs?: number;
}

export interface WebhookSendResult {
  deliveredCount: number;
  warnings: string[];
}

// Sends one body. Returns null on success, or why it failed (plain English).
async function postOnce(input: WebhookSendInput, body: string): Promise<string | null> {
  const timeoutMs = input.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "vika", "X-Vika-Event": REGRESSION_DETECTED_EVENT };
  if (input.webhook.secret !== null) headers[SIGNATURE_HEADER] = signWebhookBody(body, input.webhook.secret);
  try {
    const response = await input.fetchFunction(input.webhook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    await response.text().catch(() => ""); // let the connection finish
    return response.ok ? null : `answered with HTTP ${response.status}`;
  } catch (error) {
    const errorName = (error as Error).name;
    return errorName === "TimeoutError" || errorName === "AbortError" ? `did not answer within ${timeoutMs / 1000} seconds` : "could not be reached";
  }
}

export async function sendRegressionWebhooks(input: WebhookSendInput): Promise<WebhookSendResult> {
  const result: WebhookSendResult = { deliveredCount: 0, warnings: [] };
  const webhookHost = new URL(input.webhook.url).host;

  for (const serviceReport of input.report.services) {
    if (serviceReport.isSkipped || serviceReport.regressions.length === 0) continue;
    try {
      const lockResult = await input.store.withRunLock(serviceReport.serviceName, async () => {
        for (const regression of serviceReport.regressions) {
          const payload = buildWebhookPayload(serviceReport.serviceName, regression);
          const key: WebhookEventKey = { service: serviceReport.serviceName, deploySha: regression.deploySha, fingerprint: regression.fingerprint };
          const stored = await input.store.findWebhookEvent(key);
          if (stored?.status === "delivered") continue;
          if (stored === undefined) await input.store.saveWebhookEvent(key, payload.eventId);

          const failure = await postOnce(input, JSON.stringify(payload));
          await input.store.recordWebhookAttempt(key, failure === null ? "delivered" : "failed");
          if (failure === null) result.deliveredCount++;
          else {
            result.warnings.push(
              `webhook at ${webhookHost} ${failure} for ${serviceReport.serviceName} deploy ${regression.deploySha.slice(0, 7)}; vika will try again on the next run`,
            );
          }
        }
      });
      if (lockResult === "busy") {
        result.warnings.push(`webhook for ${serviceReport.serviceName} not sent: another vika run is working on it; it will be sent next time`);
      }
    } catch {
      // A database problem: say so, but never fail the run because of the webhook.
      result.warnings.push(`webhook for ${serviceReport.serviceName} not sent this run (could not record it); it will be tried next time`);
    }
  }
  return result;
}
