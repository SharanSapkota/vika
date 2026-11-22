import type { z } from "zod";

export class ConfigurationError extends Error {
  readonly problems: string[];

  constructor(heading: string, problems: string[]) {
    super(`${heading}\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigurationError";
    this.problems = problems;
  }
}

function formatSettingName(path: PropertyKey[]): string {
  let settingName = "";
  for (const part of path) {
    if (typeof part === "number") settingName += `[${part}]`;
    else settingName += settingName === "" ? String(part) : `.${String(part)}`;
  }
  return settingName === "" ? "vika.yaml" : settingName;
}

export function describeSchemaIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue): string[] => {
    const settingName = formatSettingName(issue.path);
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${formatSettingName([...issue.path, key])} is not a known setting (check the spelling)`);
    }
    if (issue.code === "invalid_key") {
      return [`service name "${String(issue.input)}" is not allowed: use lowercase letters, digits and dashes only`];
    }
    
    if ((issue.code === "invalid_type" || issue.code === "invalid_union") && issue.input === undefined) {
      return [`${settingName} is missing`];
    }
    if (issue.code === "invalid_value") {
      const choices = issue.values.map((value) => `"${String(value)}"`).join(", ");
      return [`${settingName} must be one of ${choices} (got "${String(issue.input)}")`];
    }
    
    return [`${settingName} ${issue.message}`];
  });
}
