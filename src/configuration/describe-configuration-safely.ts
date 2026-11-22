import { maskDatabaseUrl } from "./database-url-checks.js";
import type { LoadedConfiguration } from "./load-configuration.js";

const HIDDEN = "(set, hidden)";

export type SafeConfigurationDescription = Omit<LoadedConfiguration, "trackerCredentials" | "explain"> & {
  trackerCredentials: Record<string, string>;
  explain: Omit<LoadedConfiguration["explain"], "apiKey"> & { apiKey: string | null };
};

export function describeConfigurationSafely(configuration: LoadedConfiguration): SafeConfigurationDescription {
  const credentials = configuration.trackerCredentials;
  const trackerCredentials: Record<string, string> =
    credentials.type === "jira"
      ? { type: "jira", baseUrl: credentials.baseUrl, email: credentials.email, apiToken: HIDDEN }
      : credentials.type === "linear"
        ? { type: "linear", apiKey: HIDDEN }
        : { type: "none" };
  return {
    ...configuration,
    databaseUrl: maskDatabaseUrl(configuration.databaseUrl),
    trackerCredentials,
    
    webhook:
      configuration.webhook === null
        ? null
        : { url: `${new URL(configuration.webhook.url).origin}/(path hidden)`, secret: configuration.webhook.secret === null ? null : HIDDEN },
    explain: { ...configuration.explain, apiKey: configuration.explain.apiKey === null ? null : HIDDEN },
  };
}
