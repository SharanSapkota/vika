// Tests `vika init`: what it detects, that the vika.yaml it writes passes
// the schema and loads, and that it never overwrites. Temp folders only.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInitCommand } from "../src/commands/init-command.js";
import { vikaYamlSchema } from "../src/configuration/configuration-schema.js";
import { loadConfiguration } from "../src/configuration/load-configuration.js";
import { defaultDetectionReaders, detectProject, makeServiceName } from "../src/project-setup/detect-project.js";
import { buildFixture, type Fixture } from "./fixture/build.js";

describe("vika init", () => {
  let fixture: Fixture;
  const temporaryFolders: string[] = [];
  const makeFolder = () => {
    const folder = mkdtempSync(join(tmpdir(), "vika-init-"));
    temporaryFolders.push(folder);
    return folder;
  };

  beforeAll(() => {
    fixture = buildFixture("direct");
  }, 60_000);
  afterAll(() => {
    temporaryFolders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("detects the fixture repo, its branch and its log, and writes a vika.yaml that loads", async () => {
    // Logs in ./logs inside the repo folder (not committed: it's the fake repo's working tree).
    mkdirSync(join(fixture.repoDir, "logs"));
    copyFileSync(fixture.logPath, join(fixture.repoDir, "logs", "app.log"));
    const emptyVarLogFolder = makeFolder();

    const result = await runInitCommand({ directory: fixture.repoDir, logFolders: [join(fixture.repoDir, "logs"), emptyVarLogFolder] });
    if (result.status !== "written") throw new Error("expected init to write the files");
    expect(result.writtenFiles).toEqual([join(fixture.repoDir, "vika.yaml"), join(fixture.repoDir, ".env.example")]);
    expect(result.detection).toMatchObject({ serviceName: "repo", isGitRepo: true, defaultBranch: "main", logFormat: "text" });
    expect(result.nextSteps).toContain("vika doctor");

    const yamlText = readFileSync(join(fixture.repoDir, "vika.yaml"), "utf8");
    const parseResult = vikaYamlSchema.safeParse(parseYaml(yamlText));
    expect(parseResult.error?.issues).toBeUndefined();
    expect(parseResult.data!.services.repo).toMatchObject({ repo: ".", logs: "logs/app.log", branch: "main", deploys: { source: "marker" } });

    const configuration = loadConfiguration({ workingDirectory: fixture.repoDir, environment: { DATABASE_URL: "postgres://vika:vika@localhost:5433/vika" } });
    expect(configuration.services.repo!.repo).toBe(fixture.repoDir);
    expect(readFileSync(join(fixture.repoDir, ".env.example"), "utf8")).toContain("DATABASE_URL=postgres://vika:vika@localhost:5433/vika");
  });

  it("never overwrites: if either file exists, it writes nothing and says which", async () => {
    const folder = makeFolder();
    writeFileSync(join(folder, ".env.example"), "MINE=1\n");
    const result = await runInitCommand({ directory: folder, logFolders: [] });
    expect(result).toEqual({ status: "refused", existingFiles: [join(folder, ".env.example")] });
    expect(existsSync(join(folder, "vika.yaml"))).toBe(false);
    expect(readFileSync(join(folder, ".env.example"), "utf8")).toBe("MINE=1\n");
  });

  it("with nothing detected, still writes a valid file with NOT DETECTED notes", async () => {
    const folder = makeFolder();
    const result = await runInitCommand({ directory: folder, logFolders: [] });
    if (result.status !== "written") throw new Error("expected init to write the files");
    expect(result.detection).toMatchObject({ isGitRepo: false, defaultBranch: null, logFiles: [], logFormat: null });
    const yamlText = readFileSync(join(folder, "vika.yaml"), "utf8");
    expect(yamlText).toContain("NOT DETECTED: this folder is not a git repository");
    expect(yamlText).toContain("NOT DETECTED: put the path of your log file here");
    expect(yamlText).toContain("NOT DETECTED: set this to your production branch");
    expect(vikaYamlSchema.safeParse(parseYaml(yamlText)).success).toBe(true);
  });

  it("finds logs in the /var/log/<name> folder (here a temp folder) and their format", async () => {
    const folder = makeFolder();
    const varLogFolder = makeFolder();
    writeFileSync(join(varLogFolder, "api.log"), '{"time":"2026-03-06T14:04:07Z","level":"error","msg":"boom"}\n');
    const detection = await detectProject(folder, [join(folder, "logs"), varLogFolder]);
    expect(detection.logFiles.map((logFile) => logFile.path)).toEqual([join(varLogFolder, "api.log")]);
    expect(detection.logFormat).toBe("json");
  });

  it("prefers the remote's default branch, and makes a clean service name", async () => {
    const fakeGit = async (_directory: string, gitArguments: string[]) => {
      if (gitArguments.includes("--is-inside-work-tree")) return { exitCode: 0, stdout: "true\n" };
      if (gitArguments.includes("refs/remotes/origin/HEAD")) return { exitCode: 0, stdout: "origin/production\n" };
      return { exitCode: 0, stdout: "feature-branch\n" };
    };
    const detection = await detectProject("/srv/My Service_2", [], { ...defaultDetectionReaders, runGit: fakeGit });
    expect(detection).toMatchObject({ isGitRepo: true, defaultBranch: "production", serviceName: "my-service-2" });
    expect(makeServiceName("/srv/___")).toBe("app");
  });
});
