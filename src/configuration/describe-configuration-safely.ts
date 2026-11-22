import { maskDatabaseUrl } from "./database-url-checks.js";
import type { LoadedConfiguration } from "./load-configuration.js";

const HIDDEN = "(set, hidden)";

export type SafeConfigurationDescription = Omit<LoadedConfiguration, "trackerCredentials"> & {
  trackerCredentials: Record<string, string>;
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
    // The URL can carry a token too (many webhook URLs do), so show only its host.
    webhook:
      configuration.webhook === null
        ? null
        : { url: `${new URL(configuration.webhook.url).origin}/(path hidden)`, secret: configuration.webhook.secret === null ? null : HIDDEN },
  };
}
