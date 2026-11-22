// Decides whether `vika report --explain` may run at all. It is checked right
// after vika.yaml is loaded, before any log, git or network work, so a
// refused --explain reads nothing for the AI and sends nothing.
import type { LoadedConfiguration } from "../configuration/load-configuration.js";

export const EXPLAIN_TURNED_OFF_MESSAGE = "AI explanations are turned off in vika.yaml (explain.enabled).";
export const EXPLAIN_KEY_MISSING_MESSAGE =
  "ANTHROPIC_API_KEY is not set (put it in .env next to vika.yaml; needed because explain.enabled is true and --explain was used).";

// The reason --explain must stop, or null when it may go on.
export function findExplainBlocker(explain: LoadedConfiguration["explain"]): string | null {
  if (!explain.isEnabled) return EXPLAIN_TURNED_OFF_MESSAGE;
  if (explain.apiKey === null) return EXPLAIN_KEY_MISSING_MESSAGE;
  return null;
}
