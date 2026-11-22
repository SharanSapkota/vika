// What the two demo scripts share: where the demo lives, its service name,
// and how they find the database (the project's .env, like vika itself).
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeEnvironment, readEnvironmentFile } from "../src/configuration/read-environment-file.js";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const DEMO_FOLDER = join(PROJECT_ROOT, "demo-fixture");
export const PROJECT_ENVIRONMENT_FILE = join(PROJECT_ROOT, ".env");
export const DEMO_SERVICE_NAME = "shopfront";

// The real environment, plus the project's .env for anything it doesn't set
// (the same rule vika uses: a variable already set always wins).
export function readDemoEnvironment(): Record<string, string | undefined> {
  return mergeEnvironment(process.env, readEnvironmentFile(PROJECT_ENVIRONMENT_FILE));
}

export function readDatabaseUrl(environment: Record<string, string | undefined>): string | undefined {
  const databaseUrl = environment.DATABASE_URL;
  return databaseUrl === undefined || databaseUrl === "" ? undefined : databaseUrl;
}
