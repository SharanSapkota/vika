// The text of the vika.yaml and .env.example that `vika init` writes, from
// what it detected. Pure. Everything it could not detect gets a sensible
// default and a "NOT DETECTED" comment saying what to change; the result
// always passes the configuration schema.
import { isAbsolute, relative } from "node:path";
import type { ProjectDetection } from "./detect-project.js";

const MAX_OTHER_LOG_FILES = 5;

// Inside the project folder, a relative path (vika.yaml lives there too).
function describePath(directory: string, filePath: string): string {
  const relativePath = relative(directory, filePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? filePath : relativePath;
}

export function buildStarterVikaYaml(detection: ProjectDetection): string {
  const { serviceName } = detection;
  const lines = [
    "# vika.yaml, written by `vika init`. Check every line, then run `vika doctor`.",
    "# Every setting is described in vika.example.yaml.",
    "services:",
    `  ${serviceName}:`,
  ];

  if (detection.isGitRepo) lines.push("    repo: . # this folder is a git repository");
  else lines.push("    repo: . # NOT DETECTED: this folder is not a git repository; point this at your service's git checkout");

  const [newestLogFile, ...otherLogFiles] = detection.logFiles;
  if (newestLogFile !== undefined) {
    const formatNote = detection.logFormat === null ? "format not recognized in the first lines" : `format: ${detection.logFormat}`;
    lines.push(`    logs: ${JSON.stringify(describePath(detection.directory, newestLogFile.path))} # detected (newest log file; ${formatNote})`);
    if (otherLogFiles.length > 0) {
      lines.push(`    # other log files found: ${otherLogFiles.slice(0, MAX_OTHER_LOG_FILES).map((file) => describePath(detection.directory, file.path)).join(", ")}`);
    }
  } else {
    lines.push(
      `    logs: logs/${serviceName}.log # NOT DETECTED: put the path of your log file here,`,
      "    # or read logs from a command instead:",
      "    # logs:",
      `    #   command: docker logs --since 24h ${serviceName}`,
    );
  }

  if (detection.defaultBranch !== null) lines.push(`    branch: ${detection.defaultBranch} # detected: the repository's default branch`);
  else lines.push('    branch: main # NOT DETECTED: set this to your production branch');

  lines.push(
    "    deploys:",
    "      source: marker # record each deploy with `vika mark-deploy` from your deploy script",
    "    # If stack traces show server paths (like /app/src/...), map them to repo",
    "    # paths. `vika doctor` suggests the right mapping:",
    "    # pathMap:",
    "    #   /app/src: src",
    "tracker:",
    "  type: none # change to jira (with project) or linear (with team) to file tickets",
    "redact: # what to hide before anything is stored",
    "  - email",
    "  - jwt",
    "  - ip",
    "  - cardlike",
    "",
  );
  return lines.join("\n");
}

export function buildStarterEnvironmentExample(): string {
  return [
    "# Copy this file to .env (next to vika.yaml) and fill it in. Never commit .env.",
    "# The default matches the database in vika's docker-compose.yml.",
    "DATABASE_URL=postgres://vika:vika@localhost:5433/vika",
    "",
    "# Only when tracker.type is jira:",
    "# JIRA_BASE_URL=https://your-company.atlassian.net",
    "# JIRA_EMAIL=you@your-company.com",
    "# JIRA_API_TOKEN=",
    "",
    "# Only when tracker.type is linear:",
    "# LINEAR_API_KEY=",
    "",
    "# Only with a webhook in vika.yaml, to sign its bodies (X-Vika-Signature):",
    "# VIKA_WEBHOOK_SECRET=",
    "",
  ].join("\n");
}

export const NEXT_STEPS = [
  "Next steps:",
  "  1. Start Postgres:   docker compose up -d --wait db   (or use your own and set DATABASE_URL)",
  "  2. Copy .env.example to .env and fill in DATABASE_URL",
  "  3. Run: vika doctor   (checks everything vika.yaml points at, and says what to fix)",
  "  4. Run: vika report   (your first report)",
].join("\n");
