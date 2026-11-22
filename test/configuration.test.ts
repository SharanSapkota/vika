// Tests configuration loading: vika.yaml validation and defaults, the .env
// reader, environment checks, safe printing and warnings. Temp folders only;
// the environment is always passed in, so the real one never leaks in.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ConfigurationError } from "../src/configuration/configuration-errors.js";
import { vikaYamlSchema } from "../src/configuration/configuration-schema.js";
import { describeConfigurationSafely } from "../src/configuration/describe-configuration-safely.js";
import { loadConfiguration, type LoadConfigurationOptions } from "../src/configuration/load-configuration.js";
import { parseEnvironmentFile } from "../src/configuration/read-environment-file.js";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const LOCAL_DATABASE_URL = "postgres://vika:local-secret@localhost:5433/vika";

const MINIMAL_YAML = ["services:", "  api:", "    repo: ./api-repo", "    logs: /var/log/api.log", ""].join("\n");

const temporaryFolders: string[] = [];
afterAll(() => {
  for (const folder of temporaryFolders) rmSync(folder, { recursive: true, force: true });
});

// A temp folder with the given files (path relative to the folder -> content).
function makeFolder(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), "vika-configuration-"));
  temporaryFolders.push(folder);
  for (const [filePath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, filePath)), { recursive: true });
    writeFileSync(join(folder, filePath), content);
  }
  return folder;
}

function loadFromYaml(yamlText: string, environment: Record<string, string> = { DATABASE_URL: LOCAL_DATABASE_URL }) {
  return loadConfiguration({ workingDirectory: makeFolder({ "vika.yaml": yamlText }), environment });
}

// The problems a failing load reports (fails the test if it doesn't fail).
function readProblems(options: LoadConfigurationOptions): string[] {
  try {
    loadConfiguration(options);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.problems;
    throw error;
  }
  throw new Error("expected loading to fail");
}

function readYamlProblems(yamlText: string): string[] {
  return readProblems({ workingDirectory: makeFolder({ "vika.yaml": yamlText }), environment: { DATABASE_URL: LOCAL_DATABASE_URL } });
}

describe("vika.yaml", () => {
  it("loads a valid file and applies the defaults", () => {
    const folder = makeFolder({ "vika.yaml": MINIMAL_YAML });
    const configuration = loadConfiguration({ workingDirectory: folder, environment: { DATABASE_URL: LOCAL_DATABASE_URL } });
    expect(configuration).toEqual({
      services: {
        api: {
          repo: join(folder, "api-repo"),
          logs: "/var/log/api.log",
          branch: "main",
          deploys: { source: "merges" },
          language: "javascript",
          logFormat: "auto",
        },
      },
      tracker: { type: "none" },
      redact: ["email", "jwt", "ip", "cardlike"],
      databaseUrl: LOCAL_DATABASE_URL,
      trackerCredentials: { type: "none" },
      webhook: null,
      explain: { isEnabled: false, provider: "anthropic", model: "claude-sonnet-5-5", maxDiffLines: 200, apiKey: null },
      configurationFilePath: join(folder, "vika.yaml"),
      warnings: [],
    });
  });

  it('language defaults to "javascript", accepts "python" and rejects anything else with the allowed values', () => {
    expect(loadFromYaml(MINIMAL_YAML).services.api!.language).toBe("javascript");
    expect(loadFromYaml(`${MINIMAL_YAML}    language: python\n`).services.api!.language).toBe("python");
    expect(readYamlProblems(`${MINIMAL_YAML}    language: ruby\n`)).toEqual([
      'services.api.language must be one of "javascript", "python" (got "ruby")',
    ]);
  });

  it('logFormat defaults to "auto", accepts text/json/nginx and rejects anything else with the allowed values', () => {
    expect(loadFromYaml(MINIMAL_YAML).services.api!.logFormat).toBe("auto");
    for (const logFormat of ["text", "json", "nginx"]) {
      expect(loadFromYaml(`${MINIMAL_YAML}    logFormat: ${logFormat}\n`).services.api!.logFormat).toBe(logFormat);
    }
    expect(readYamlProblems(`${MINIMAL_YAML}    logFormat: syslog\n`)).toEqual([
      'services.api.logFormat must be one of "auto", "text", "json", "nginx" (got "syslog")',
    ]);
    // Unknown keys are still rejected.
    expect(readYamlProblems(`${MINIMAL_YAML}    langauge: python\n`).join("\n")).toMatch(/langauge/);
  });

  it('reads a custom branch "production" and rejects an empty branch', () => {
    const configuration = loadFromYaml(`${MINIMAL_YAML}    branch: production\n`);
    expect(configuration.services.api!.branch).toBe("production");
    expect(readYamlProblems(`${MINIMAL_YAML}    branch: ""\n`)).toEqual(["services.api.branch must not be empty"]);
  });

  it("accepts logs as a path or as { command }, and rejects any other shape", () => {
    expect(loadFromYaml(MINIMAL_YAML).services.api!.logs).toBe("/var/log/api.log");

    const commandYaml = MINIMAL_YAML.replace("logs: /var/log/api.log", "logs:\n      command: docker logs api");
    expect(loadFromYaml(commandYaml).services.api!.logs).toEqual({ command: "docker logs api" });

    for (const badLogs of ["logs: 42", "logs:\n      cmd: docker logs api"]) {
      const problems = readYamlProblems(MINIMAL_YAML.replace("logs: /var/log/api.log", badLogs));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^services\.api\.logs must be a log file path/);
    }
  });

  it("names the exact setting for missing services, missing logs, a bad service name and an unknown deploy source", () => {
    expect(readYamlProblems("tracker:\n  type: none\n")).toEqual(["services is missing"]);
    expect(readYamlProblems("services: {}\n")).toEqual(["services must list at least one service"]);
    expect(readYamlProblems("services:\n  api:\n    repo: ./api-repo\n")).toEqual(["services.api.logs is missing"]);
    expect(readYamlProblems(MINIMAL_YAML.replace("  api:", "  Api_Main:"))).toEqual([
      'service name "Api_Main" is not allowed: use lowercase letters, digits and dashes only',
    ]);
    expect(readYamlProblems(`${MINIMAL_YAML}    deploys:\n      source: jenkins\n`)).toEqual([
      'services.api.deploys.source must be one of "merges", "marker", "logs-version", "github" (got "jenkins")',
    ]);
  });

  it("reports every problem in the file at once", () => {
    const problems = readYamlProblems(
      ["services:", "  api:", "    logs: /var/log/api.log", '    branch: ""', "    brnach: main", "tracker:", "  type: trello", ""].join("\n"),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "services.api.repo is missing",
        "services.api.branch must not be empty",
        "services.api.brnach is not a known setting (check the spelling)",
        'tracker.type must be "jira", "linear" or "none"',
      ]),
    );
  });

  it("resolves a relative repo path against the folder that holds vika.yaml", () => {
    const folder = makeFolder({ "settings/vika.yaml": MINIMAL_YAML.replace("./api-repo", "../repos/api") });
    const configuration = loadConfiguration({
      workingDirectory: folder,
      configurationPath: "settings/vika.yaml",
      environment: { DATABASE_URL: LOCAL_DATABASE_URL },
    });
    expect(configuration.services.api!.repo).toBe(join(folder, "repos", "api"));
  });

  it("says where it looked when vika.yaml is missing", () => {
    const folder = makeFolder({});
    const problems = readProblems({ workingDirectory: folder, environment: { DATABASE_URL: LOCAL_DATABASE_URL } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`looked for ${join(folder, "vika.yaml")}`);
  });

  it("vika.example.yaml passes the schema", () => {
    const exampleText = readFileSync(join(PROJECT_ROOT, "vika.example.yaml"), "utf8");
    const parseResult = vikaYamlSchema.safeParse(parseYaml(exampleText));
    expect(parseResult.error?.issues).toBeUndefined();
    expect(Object.keys(parseResult.data!.services)).toEqual(["orders-api", "payments-worker", "storefront-web", "checkout-api"]);
    expect(parseResult.data!.services["checkout-api"]).toMatchObject({ language: "python", logFormat: "text" });
    expect(parseResult.data!.services["orders-api"]).toMatchObject({ language: "javascript", logFormat: "auto" });
  });

  it("rejects an empty redact list: redacting nothing is unsafe", () => {
    expect(readYamlProblems(`${MINIMAL_YAML}redact: []\n`)).toEqual([
      "redact must list at least one kind (email, jwt, ip, cardlike): redacting nothing is unsafe",
    ]);
    expect(loadFromYaml(`${MINIMAL_YAML}redact:\n  - ip\n`).redact).toEqual(["ip"]);
  });

  it('Jira issueType defaults to "Bug" and can be set', () => {
    const jiraEnvironment = { DATABASE_URL: LOCAL_DATABASE_URL, JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "ops@example.com", JIRA_API_TOKEN: "token" };
    expect(loadFromYaml(`${MINIMAL_YAML}tracker:\n  type: jira\n  project: OPS\n`, jiraEnvironment).tracker).toEqual({ type: "jira", project: "OPS", issueType: "Bug" });
    expect(loadFromYaml(`${MINIMAL_YAML}tracker:\n  type: jira\n  project: OPS\n  issueType: Task\n`, jiraEnvironment).tracker).toEqual({ type: "jira", project: "OPS", issueType: "Task" });
    expect(readYamlProblems(`${MINIMAL_YAML}tracker:\n  type: jira\n  project: OPS\n  issueType: ""\n`)).toEqual(["tracker.issueType must not be empty"]);
  });
});

describe("environment", () => {
  const JIRA_YAML = `${MINIMAL_YAML}tracker:\n  type: jira\n  project: OPS\n`;

  it("requires DATABASE_URL", () => {
    expect(readProblems({ workingDirectory: makeFolder({ "vika.yaml": MINIMAL_YAML }), environment: {} })).toEqual([
      "DATABASE_URL is not set (put it in .env)",
    ]);
  });

  it("reports every missing Jira variable together, in one error", () => {
    const problems = readProblems({ workingDirectory: makeFolder({ "vika.yaml": JIRA_YAML }), environment: { JIRA_EMAIL: "ops@example.com" } });
    expect(problems).toEqual([
      "DATABASE_URL is not set (put it in .env)",
      'JIRA_BASE_URL is not set (put it in .env; needed because tracker.type is "jira")',
      'JIRA_API_TOKEN is not set (put it in .env; needed because tracker.type is "jira")',
    ]);
  });

  it("reads .env next to vika.yaml, but never overrides the real environment", () => {
    const folder = makeFolder({
      "vika.yaml": `${MINIMAL_YAML}tracker:\n  type: linear\n  team: ENG\n`,
      ".env": "DATABASE_URL=postgres://from-file@localhost/vika\nLINEAR_API_KEY=lin_from_file\n",
    });
    const configuration = loadConfiguration({ workingDirectory: folder, environment: { DATABASE_URL: LOCAL_DATABASE_URL } });
    expect(configuration.databaseUrl).toBe(LOCAL_DATABASE_URL);
    expect(configuration.trackerCredentials).toEqual({ type: "linear", apiKey: "lin_from_file" });
  });

  it(".env parser: KEY=value, quotes, comments and blank lines", () => {
    const fileText = [
      "# a comment",
      "",
      "PLAIN=value",
      "WITH_COMMENT=value # trailing comment",
      "HASH_INSIDE=a#b",
      'DOUBLE="two words # not a comment"',
      'ESCAPED="line one\\nline \\"two\\""',
      "SINGLE='literal \\n stays'",
      "EMPTY=",
      "SPACED = spaced value ",
    ].join("\n");
    expect(parseEnvironmentFile(fileText, ".env")).toEqual({
      PLAIN: "value",
      WITH_COMMENT: "value",
      HASH_INSIDE: "a#b",
      DOUBLE: "two words # not a comment",
      ESCAPED: 'line one\nline "two"',
      SINGLE: "literal \\n stays",
      EMPTY: "",
      SPACED: "spaced value",
    });
  });

  it(".env parser: a broken line is reported by number, without its secret value", () => {
    let message = "";
    try {
      parseEnvironmentFile("GOOD=1\nthis line holds hunter2\nTOKEN=\"unclosed hunter2\n", ".env");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(".env line 2 is not KEY=value");
    expect(message).toContain(".env line 3 is not KEY=value");
    expect(message).not.toContain("hunter2");
  });
});

describe("safe printing and warnings", () => {
  it("describeConfigurationSafely never contains the password or any token", () => {
    const secrets = { password: "db-pass-9f8e7d", jiraToken: "jira-token-1a2b3c", linearKey: "lin_api_4d5e6f" };
    const jiraConfiguration = loadFromYaml(`${MINIMAL_YAML}tracker:\n  type: jira\n  project: OPS\n`, {
      DATABASE_URL: `postgres://vika:${secrets.password}@db.example.com:5432/vika?sslmode=require&password=${secrets.password}`,
      JIRA_BASE_URL: "https://example.atlassian.net",
      JIRA_EMAIL: "ops@example.com",
      JIRA_API_TOKEN: secrets.jiraToken,
    });
    const linearConfiguration = loadFromYaml(`${MINIMAL_YAML}tracker:\n  type: linear\n  team: ENG\n`, {
      DATABASE_URL: `postgres://vika:${secrets.password}@localhost/vika`,
      LINEAR_API_KEY: secrets.linearKey,
    });

    for (const configuration of [jiraConfiguration, linearConfiguration]) {
      const printed = JSON.stringify(describeConfigurationSafely(configuration));
      for (const secret of Object.values(secrets)) expect(printed).not.toContain(secret);
    }
    const safeJira = describeConfigurationSafely(jiraConfiguration);
    expect(safeJira.databaseUrl).toContain("postgres://vika:****@db.example.com:5432/vika");
    expect(safeJira.trackerCredentials).toEqual({
      type: "jira",
      baseUrl: "https://example.atlassian.net",
      email: "ops@example.com",
      apiToken: "(set, hidden)",
    });
  });

  it("warns about a pooler host and a remote database without sslmode", () => {
    const poolerConfiguration = loadFromYaml(MINIMAL_YAML, { DATABASE_URL: "postgres://vika:secret@ep-quiet-lake-123-pooler.eu-central-1.aws.neon.tech/vika" });
    expect(poolerConfiguration.warnings).toHaveLength(2);
    expect(poolerConfiguration.warnings[0]).toContain("-pooler");
    expect(poolerConfiguration.warnings[1]).toContain("sslmode");
    for (const warning of poolerConfiguration.warnings) expect(warning).not.toContain("secret");

    const directConfiguration = loadFromYaml(MINIMAL_YAML, { DATABASE_URL: "postgres://vika:secret@db.example.com/vika?sslmode=require" });
    expect(directConfiguration.warnings).toEqual([]);
  });
});
