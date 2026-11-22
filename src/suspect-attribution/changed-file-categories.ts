// Recognizes changed files that can break a service without touching the
// code in the stack trace: dependency lockfiles, config files, migrations.
import type { ChangedFileCategory } from "./suspect-types.js";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
]);

const CONFIG_FILE_NAMES = new Set(["package.json", "Dockerfile", ".env"]);
const CONFIG_EXTENSIONS = [".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".properties"];
const CONFIG_NAME_PATTERNS = [/^\.env\./, /\.config\.(?:js|cjs|mjs|ts|json)$/, /^docker-compose\./];
const CONFIG_FOLDERS = new Set(["config", "configs", "configuration", "settings"]);

const MIGRATION_FOLDERS = new Set(["migrations", "migration", "migrate"]);

// Returns undefined for ordinary source files.
export function categorizeChangedFile(filePath: string): ChangedFileCategory | undefined {
  const pathParts = filePath.split("/");
  const fileName = pathParts[pathParts.length - 1] ?? "";
  const folderNames = pathParts.slice(0, -1);

  if (LOCKFILE_NAMES.has(fileName)) return "lockfile";
  // Migrations first: a .sql or .yaml file inside migrations/ is a migration, not config.
  if (folderNames.some((folderName) => MIGRATION_FOLDERS.has(folderName)) || fileName.endsWith(".sql")) return "migration";
  if (
    CONFIG_FILE_NAMES.has(fileName) ||
    CONFIG_EXTENSIONS.some((extension) => fileName.endsWith(extension)) ||
    CONFIG_NAME_PATTERNS.some((pattern) => pattern.test(fileName)) ||
    folderNames.some((folderName) => CONFIG_FOLDERS.has(folderName))
  ) {
    return "config file";
  }
  return undefined;
}
