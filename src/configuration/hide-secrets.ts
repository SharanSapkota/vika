


import type { LoadedConfiguration } from "./load-configuration.js";
import { parseDatabaseUrl } from "./database-url-checks.js";

const MASK = "****";





const MIN_FREESTANDING_SECRET_LENGTH = 6;



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
  
  if (configuration.webhook !== null) {
    secrets.push(configuration.webhook.url);
    if (configuration.webhook.secret !== null) secrets.push(configuration.webhook.secret);
  }
  
  const explainApiKey = configuration.explain?.apiKey ?? null;
  if (explainApiKey !== null) secrets.push(explainApiKey);
  return [...new Set(secrets.filter((secret) => secret !== ""))].sort((left, right) => right.length - left.length);
}

export function hideSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((maskedText, secret) => maskedText.split(secret).join(MASK), text);
}


export async function runWithSecretsHidden<Result>(configuration: LoadedConfiguration, work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    const secrets = collectSecrets(configuration);
    throw new Error(hideSecrets(error instanceof Error ? error.message : String(error), secrets));
  }
}
