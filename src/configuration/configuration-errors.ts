// One error that lists every configuration problem at once, so a customer
// fixes them all in one go instead of one per run. Messages name the exact
// setting ("services.api.logs is missing") and never include secret values.
import type { z } from "zod";

export class ConfigurationError extends Error {
  readonly problems: string[];

  constructor(heading: string, problems: string[]) {
    super(`${heading}\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigurationError";
    this.problems = problems;
  }
}

// ["services", "api", "logs"] -> "services.api.logs"; ["redact", 0] -> "redact[0]".
function formatSettingName(path: PropertyKey[]): string {
  let settingName = "";
  for (const part of path) {
    if (typeof part === "number") settingName += `[${part}]`;
    else settingName += settingName === "" ? String(part) : `.${String(part)}`;
  }
  return settingName === "" ? "vika.yaml" : settingName;
}

// zod issues (parsed with reportInput: true) -> plain-English problems.
// The input is only ever echoed for short choice values, never for whole objects.
export function describeSchemaIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue): string[] => {
    const settingName = formatSettingName(issue.path);
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${formatSettingName([...issue.path, key])} is not a known setting (check the spelling)`);
    }
    if (issue.code === "invalid_key") {
      return [`service name "${String(issue.input)}" is not allowed: use lowercase letters, digits and dashes only`];
    }
    // A setting that isn't there at all.
    if ((issue.code === "invalid_type" || issue.code === "invalid_union") && issue.input === undefined) {
      return [`${settingName} is missing`];
    }
    if (issue.code === "invalid_value") {
      const choices = issue.values.map((value) => `"${String(value)}"`).join(", ");
      return [`${settingName} must be one of ${choices} (got "${String(issue.input)}")`];
    }
    // Every other message comes from the schema and reads after the name.
    return [`${settingName} ${issue.message}`];
  });
}
