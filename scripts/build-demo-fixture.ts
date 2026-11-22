// npm run demo:fixture
//
// Puts the "direct" test fixture in ./demo-fixture/ so you can try the real
// vika commands on it: the fake repo, app.log, deploys.json, expected.json, a
// vika.yaml for the service "shopfront" (deploys source "marker"), and a link
// to the project's .env (so DATABASE_URL comes from there). It then records
// every deploy from deploys.json with the real mark-deploy logic.
//
// The fake repo is built (and committed to) in a temp folder outside this
// project, as always (test/fixture/build.ts refuses anything else); only the
// finished files are copied here. This script runs no git command in this
// project. ./demo-fixture is in .gitignore.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMarkDeployCommand } from "../src/commands/mark-deploy-command.js";
import { maskDatabaseUrl } from "../src/configuration/database-url-checks.js";
import { buildFixture, type Deploy } from "../test/fixture/build.js";
import { DEMO_FOLDER, DEMO_SERVICE_NAME, PROJECT_ENVIRONMENT_FILE, readDatabaseUrl, readDemoEnvironment } from "./demo-fixture-settings.js";

const VIKA_YAML = `# vika.yaml for the demo fixture (written by npm run demo:fixture).
# Paths are relative to this file. DATABASE_URL comes from the project's .env
# (the .env here links to it).
services:
  ${DEMO_SERVICE_NAME}:
    repo: ./repo
    logs: ./app.log
    pathMap:
      /app/src: src # the fake app's stack traces say /app/src/...; the repo has src/...
    deploys:
      source: marker # deploys.json was recorded with mark-deploy
`;

async function buildDemoFixture(): Promise<void> {
  if (existsSync(DEMO_FOLDER)) {
    throw new Error("demo-fixture/ already exists. Run `npm run demo:reset` first, then `npm run demo:fixture` again.");
  }
  const environment = readDemoEnvironment();
  const databaseUrl = readDatabaseUrl(environment);
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set: put it in the project's .env (see .env.example).");

  // 1. Build the fixture outside the project, then copy the finished files in.
  const fixture = buildFixture("direct");
  try {
    mkdirSync(DEMO_FOLDER);
    cpSync(fixture.repoDir, join(DEMO_FOLDER, "repo"), { recursive: true });
    for (const fileName of ["app.log", "deploys.json", "expected.json"]) cpSync(join(fixture.root, fileName), join(DEMO_FOLDER, fileName));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  if (!existsSync(join(DEMO_FOLDER, "repo", ".git"))) throw new Error("the copied fake repo has no .git folder; delete demo-fixture/ and try again");

  // 2. vika.yaml, and .env as a link to the project's .env (no copy of any secret).
  writeFileSync(join(DEMO_FOLDER, "vika.yaml"), VIKA_YAML);
  if (existsSync(PROJECT_ENVIRONMENT_FILE)) symlinkSync("../.env", join(DEMO_FOLDER, ".env"));

  // 3. Record every deploy, oldest first, with the real mark-deploy logic.
  const deploys = JSON.parse(readFileSync(join(DEMO_FOLDER, "deploys.json"), "utf8")) as Deploy[];
  for (const deploy of deploys) {
    const result = await runMarkDeployCommand({
      workingDirectory: DEMO_FOLDER,
      environment,
      serviceName: DEMO_SERVICE_NAME,
      sha: deploy.sha,
      ...(deploy.previousSha === null ? {} : { previousSha: deploy.previousSha }),
      time: deploy.time,
      clock: () => new Date(), // not used: every deploy has its own time
    });
    console.log(`${result.isNew ? "Recorded" : "Already recorded"} deploy ${deploy.sha.slice(0, 7)} at ${deploy.time}`);
  }

  const expected = JSON.parse(readFileSync(join(DEMO_FOLDER, "expected.json"), "utf8")) as { suspectSha: string; suspectPr: number; suspectAuthor: string; badDeploySha: string };
  console.log(
    [
      "",
      `Demo fixture ready in demo-fixture/ (service "${DEMO_SERVICE_NAME}", ${deploys.length} deploys recorded).`,
      `Database: ${maskDatabaseUrl(databaseUrl)}`,
      `The planted bug: PR #${expected.suspectPr} by ${expected.suspectAuthor} (commit ${expected.suspectSha.slice(0, 7)}), shipped in deploy ${expected.badDeploySha.slice(0, 7)}.`,
      "",
      "Next, from the project folder:",
      "  npx tsx src/cli.ts doctor --config demo-fixture/vika.yaml",
      "  npx tsx src/cli.ts run --config demo-fixture/vika.yaml",
      "  npx tsx src/cli.ts report --config demo-fixture/vika.yaml",
      "  npx tsx src/cli.ts serve --config demo-fixture/vika.yaml    # then open http://127.0.0.1:4173",
      "",
      "When you are done:",
      "  npm run demo:reset",
      "",
    ].join("\n"),
  );
}

buildDemoFixture().catch((error: unknown) => {
  console.error(`demo:fixture: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
