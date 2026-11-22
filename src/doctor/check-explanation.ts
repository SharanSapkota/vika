

import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import { failCheck, passCheck, type DoctorCheck } from "./doctor-check-types.js";

const AREA = "explain";

export function checkExplanation(explain: LoadedConfiguration["explain"]): DoctorCheck[] {
  if (!explain.isEnabled) return [passCheck(AREA, "AI explanations: off")];
  if (explain.apiKey === null) {
    return [
      failCheck(
        AREA,
        `AI explanations: on (model ${explain.model}), but ANTHROPIC_API_KEY is not set`,
        "add ANTHROPIC_API_KEY to .env next to vika.yaml, or set explain.enabled: false",
      ),
    ];
  }
  return [passCheck(AREA, `AI explanations: on (model ${explain.model})`)];
}
