
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigurationError, describeSchemaIssues } from "./configuration-errors.js";
import { vikaYamlSchema, type ExplainProvider, type RedactionKind, type ServiceSettings, type TrackerSettings } from "./configuration-schema.js";
import { findDatabaseUrlWarnings, parseDatabaseUrl } from "./database-url-checks.js";
import { mergeEnvironment, readEnvironmentFile } from "./read-environment-file.js";

export const CONFIGURATION_FILE_NAME = "vika.yaml";
export const ENVIRONMENT_FILE_NAME = ".env";

export type TrackerCredentials =
  | { type: "jira"; baseUrl: string; email: string; apiToken: string }
  | { type: "linear"; apiKey: string }
  | { type: "none" };



export interface ExplainConfiguration {
  isEnabled: boolean;
  provider: ExplainProvider;
  model: string;
  maxDiffLines: number;
  
  
  apiKey: string | null;
}

export interface LoadedConfiguration {
  services: Record<string, ServiceSettings>; 
  tracker: TrackerSettings;
  redact: RedactionKind[];
  databaseUrl: string;
  trackerCredentials: TrackerCredentials;
  
  
  webhook: { url: string; secret: string | null } | null;
  explain: ExplainConfiguration;
  configurationFilePath: string;
  warnings: string[]; 
}

export interface LoadConfigurationOptions {
  workingDirectory: string;
  configurationPath?: string; 
  
  environment?: Record<string, string | undefined>;
}


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

  
  const parseResult = vikaYamlSchema.safeParse(readYamlFile(configurationFilePath), { reportInput: true });
  if (!parseResult.success) {
    throw new ConfigurationError(`Problems in ${configurationFilePath}:`, describeSchemaIssues(parseResult.error.issues));
  }
  const vikaYaml = parseResult.data;

  
  const services: Record<string, ServiceSettings> = {};
  for (const [serviceName, serviceSettings] of Object.entries(vikaYaml.services)) {
    services[serviceName] = { ...serviceSettings, repo: resolve(configurationDirectory, serviceSettings.repo) };
  }

  
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
    explain: {
      isEnabled: vikaYaml.explain.enabled,
      provider: vikaYaml.explain.provider,
      model: vikaYaml.explain.model,
      maxDiffLines: vikaYaml.explain.maxDiffLines,
      
      apiKey: vikaYaml.explain.enabled ? (readVariable("ANTHROPIC_API_KEY") ?? null) : null,
    },
    configurationFilePath,
    warnings: findDatabaseUrlWarnings(parsedDatabaseUrl),
  };
}
