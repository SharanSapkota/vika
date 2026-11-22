// Doctor: is the webhook set up right? An invalid URL never gets this far
// (vika.yaml fails to load and check-configuration reports it under
// "webhook"). Shows only the URL's host: the path often carries a token.
// Pure; sends nothing.
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import { passCheck, warnCheck, type DoctorCheck } from "./doctor-check-types.js";

const AREA = "webhook";

export function checkWebhook(webhook: LoadedConfiguration["webhook"]): DoctorCheck[] {
  if (webhook === null) return [];
  const host = new URL(webhook.url).host;
  const checks = [passCheck(AREA, `webhook URL on ${host} is valid; \`vika run\` posts each new regression there once`)];
  if (webhook.secret === null) {
    checks.push(warnCheck(AREA, "no VIKA_WEBHOOK_SECRET is set, so webhook bodies are not signed", "set VIKA_WEBHOOK_SECRET in .env so the receiver can check X-Vika-Signature"));
  }
  return checks;
}
