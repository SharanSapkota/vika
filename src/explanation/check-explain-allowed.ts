


import type { LoadedConfiguration } from "../configuration/load-configuration.js";

export const EXPLAIN_TURNED_OFF_MESSAGE = "AI explanations are turned off in vika.yaml (explain.enabled).";
export const EXPLAIN_KEY_MISSING_MESSAGE =
  "ANTHROPIC_API_KEY is not set (put it in .env next to vika.yaml; needed because explain.enabled is true and --explain was used).";


export function findExplainBlocker(explain: LoadedConfiguration["explain"]): string | null {
  if (!explain.isEnabled) return EXPLAIN_TURNED_OFF_MESSAGE;
  if (explain.apiKey === null) return EXPLAIN_KEY_MISSING_MESSAGE;
  return null;
}
