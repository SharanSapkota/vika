// Finds and loads vika.yaml and the .env next to it, checks both, and
// returns plain data. No database, no git, nothing is started.
//
// All problems found at one stage are reported together in one error:
// first everything wrong in vika.yaml, then every missing environment
// variable. Errors never include a secret value.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigurationError, describeSchemaIssues } from "./configuration-errors.js";
import { vikaYamlSchema, type RedactionKind, type ServiceSettings, type TrackerSettings } from "./configuration-schema.js";
import { findDatabaseUrlWarnings, parseDatabaseUrl } from "./database-url-checks.js";
import { mergeEnvironment, readEnvironmentFile } from "./read-environment-file.js";

export const CONFIGURATION_FILE_NAME = "vika.yaml";
export const ENVIRONMENT_FILE_NAME = ".env";

export type TrackerCredentials =
  | { type: "jira"; baseUrl: string; email: string; apiToken: string }
  | { type: "linear"; apiKey: string }
  | { type: "none" };

export interface LoadedConfiguration {
  services: Record<string, ServiceSettings>; // repo paths are absolute
  tracker: TrackerSettings;
  redact: RedactionKind[];
  databaseUrl: string;
  trackerCredentials: TrackerCredentials;
  // Where `vika run` posts new regressions; null when vika.yaml has no webhook.
  // The signing secret comes from VIKA_WEBHOOK_SECRET (optional).
  webhook: { url: string; secret: string | null } | null;
  configurationFilePath: string;
  warnings: string[]; // advice that doesn't stop vika from running
}

export interface LoadConfigurationOptions {
  workingDirectory: string;
  configurationPath?: string; // default: vika.yaml in workingDirectory
  // The real environment; tests pass their own. Default: process.env.
  environment?: Record<string, string | undefined>;
}

// Where each tracker's secrets come from.
const TRACKER_VARIABLES = {
  jira: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  linear: ["LINEAR_API_KEY"],
  none: [],
} as const;

function readYamlFile(configurationFilePath: string): unknown {
  let fileText: string;
  try {
    fileText = readFileSync(configurationFilePath, "utf8");
  } catch (error) {
    throw new ConfigurationError(`Cannot read ${configurationFilePath}:`, [(error as Error).message]);
  }
  try {
    // An empty file parses as null; treat it as an empty map so the
    // message is "services is missing".
    return parseYaml(fileText) ?? {};
  } catch (error) {
    throw new ConfigurationError(`${configurationFilePath} is not valid YAML:`, [(error as Error).message]);
  }
}

export function loadConfiguration(options: LoadConfigurationOptions): LoadedConfiguration {
  const workingDirectory = resolve(options.workingDirectory);
  const configurationFilePath = resolve(workingDirectory, options.configurationPath ?? CONFIGURATION_FILE_NAME);
  if (!existsSync(configurationFilePath)) {
    throw new ConfigurationError("Configuration file not found:", [
      `looked for ${configurationFilePath}` +
        (options.configurationPath === undefined ? ` (pass a path to use a ${CONFIGURATION_FILE_NAME} somewhere else)` : ""),
    ]);
  }
  const configurationDirectory = dirname(configurationFilePath);

  // 1. vika.yaml
  const parseResult = vikaYamlSchema.safeParse(readYamlFile(configurationFilePath), { reportInput: true });
  if (!parseResult.success) {
    throw new ConfigurationError(`Problems in ${configurationFilePath}:`, describeSchemaIssues(parseResult.error.issues));
  }
  const vikaYaml = parseResult.data;

  // Relative repo paths mean "relative to vika.yaml", not to wherever vika was started.
  const services: Record<string, ServiceSettings> = {};
  for (const [serviceName, serviceSettings] of Object.entries(vikaYaml.services)) {
    services[serviceName] = { ...serviceSettings, repo: resolve(configurationDirectory, serviceSettings.repo) };
  }

  // 2. The environment: the real one wins over .env.
  const environment = mergeEnvironment(
    options.environment ?? process.env,
    readEnvironmentFile(join(configurationDirectory, ENVIRONMENT_FILE_NAME)),
  );
  const readVariable = (name: string) => {
    const value = environment[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const trackerType = vikaYaml.tracker.type;
  const missingProblems = ["DATABASE_URL", ...TRACKER_VARIABLES[trackerType]]
    .filter((name) => readVariable(name) === undefined)
    .map((name) =>
      name === "DATABASE_URL"
        ? "DATABASE_URL is not set (put it in .env)"
        : `${name} is not set (put it in .env; needed because tracker.type is "${trackerType}")`,
    );
  if (missingProblems.length > 0) throw new ConfigurationError("Missing environment variables:", missingProblems);

  const databaseUrl = readVariable("DATABASE_URL")!;
  const parsedDatabaseUrl = parseDatabaseUrl(databaseUrl);
  if (parsedDatabaseUrl === undefined) {
    throw new ConfigurationError("Bad environment variable:", [
      "DATABASE_URL is not a valid URL (expected postgres://user:password@host:5432/database)",
    ]);
  }

  const trackerCredentials: TrackerCredentials =
    trackerType === "jira"
      ? { type: "jira", baseUrl: readVariable("JIRA_BASE_URL")!, email: readVariable("JIRA_EMAIL")!, apiToken: readVariable("JIRA_API_TOKEN")! }
      : trackerType === "linear"
        ? { type: "linear", apiKey: readVariable("LINEAR_API_KEY")! }
        : { type: "none" };

  return {
    services,
    tracker: vikaYaml.tracker,
    redact: vikaYaml.redact,
    databaseUrl,
    trackerCredentials,
    webhook: vikaYaml.webhook === undefined ? null : { url: vikaYaml.webhook.url, secret: readVariable("VIKA_WEBHOOK_SECRET") ?? null },
    configurationFilePath,
    warnings: findDatabaseUrlWarnings(parsedDatabaseUrl),
  };
}
