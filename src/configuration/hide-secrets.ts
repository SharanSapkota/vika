// Makes sure no secret from the configuration ends up in an error message.
// Errors can come from libraries (the Postgres driver, git) that may echo
// what they were given, so every message from a command passes through here.
import type { LoadedConfiguration } from "./load-configuration.js";
import { parseDatabaseUrl } from "./database-url-checks.js";

const MASK = "****";

// A password shorter than this (like the docker-compose default "vika") is
// masked only where it appears as "user:password@": masking a short common
// word everywhere would garble every message and ticket that contains it.
// The full URL and every tracker token are always masked wherever they appear.
const MIN_FREESTANDING_SECRET_LENGTH = 6;

// The secret values in a configuration, longest first (so a password that
// contains another secret is masked whole).
export function collectSecrets(configuration: LoadedConfiguration): string[] {
  const secrets = [configuration.databaseUrl];
  const parsedDatabaseUrl = parseDatabaseUrl(configuration.databaseUrl);
  if (parsedDatabaseUrl !== undefined && parsedDatabaseUrl.password !== "") {
    for (const password of [parsedDatabaseUrl.password, decodeURIComponent(parsedDatabaseUrl.password)]) {
      secrets.push(password.length >= MIN_FREESTANDING_SECRET_LENGTH ? password : `${parsedDatabaseUrl.username}:${password}@`);
    }
  }
  const credentials = configuration.trackerCredentials;
  if (credentials.type === "jira") secrets.push(credentials.apiToken);
  if (credentials.type === "linear") secrets.push(credentials.apiKey);
  // Webhook URLs often carry a token in their path, so the whole URL is a secret.
  if (configuration.webhook !== null) {
    secrets.push(configuration.webhook.url);
    if (configuration.webhook.secret !== null) secrets.push(configuration.webhook.secret);
  }
  // Some scripts and tests pass a partial configuration without `explain`.
  const explainApiKey = configuration.explain?.apiKey ?? null;
  if (explainApiKey !== null) secrets.push(explainApiKey);
  return [...new Set(secrets.filter((secret) => secret !== ""))].sort((left, right) => right.length - left.length);
}

export function hideSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((maskedText, secret) => maskedText.split(secret).join(MASK), text);
}

// Runs the work; if it throws, throws the same message with secrets masked.
export async function runWithSecretsHidden<Result>(configuration: LoadedConfiguration, work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    const secrets = collectSecrets(configuration);
    throw new Error(hideSecrets(error instanceof Error ? error.message : String(error), secrets));
  }
}
