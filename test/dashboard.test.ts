// Tests `vika serve`: it listens on 127.0.0.1 only, the page has no external
// URLs and never inserts report data as HTML, /api/report equals
// `report --json`, and POST /api/tickets is refused without the token, from
// another origin or another Host, and files exactly once with it.
// Fake tracker only; needs TEST_DATABASE_URL.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as sendHttpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/commands/run-cli.js";
import { runServeCommand, type RunningServe } from "../src/commands/serve-command.js";
import { makeGitHubNewIssueUrl } from "../src/dashboard/github-issue-link.js";
import { checkRequest } from "../src/dashboard/request-guard.js";
import type { Report } from "../src/reporting/report-types.js";
import { buildFixture, type Fixture } from "./fixture/build.js";
import { buildReportProject, type ReportProject, type ReportProjectOptions } from "./fixture/build-report-project.js";
import { createFakeJira, createForbiddenFetch, type FakeJira } from "./fixture/fake-trackers.js";

const JIRA_ENVIRONMENT = { JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "ops@example.com", JIRA_API_TOKEN: "jira-token-Dash9Xz2" };
const HTML_INSERTION = /innerHTML|outerHTML|insertAdjacentHTML|document\.write/;

// A raw request, so tests can send any Host header (fetch won't let them).
function sendRaw(port: number, path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = sendHttpRequest({ host: "127.0.0.1", port, path, method, headers }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("vika serve", () => {
  let fixture: Fixture;
  const projects: ReportProject[] = [];
  const servers: RunningServe[] = [];

  beforeAll(() => {
    fixture = buildFixture("direct");
  }, 60_000);
  afterAll(async () => {
    for (const server of servers) await server.stop();
    projects.forEach((project) => project.remove());
    rmSync(fixture.root, { recursive: true, force: true });
  });

  // A project with stored data (after `vika run`) and its dashboard on a free port.
  async function startDashboard(options: ReportProjectOptions = {}, fakeJira: FakeJira = createFakeJira()) {
    const project = await buildReportProject("direct", { fixture, trackerYamlLines: ["tracker:", "  type: jira", "  project: OPS"], extraEnvironment: JIRA_ENVIRONMENT, ...options });
    projects.push(project);
    expect((await project.runVika(["run"])).exitCode).toBe(0);
    const server = await runServeCommand({
      workingDirectory: project.folder,
      environment: project.environment,
      storeOptions: project.storeOptions,
      fetchFunction: fakeJira.fetchFunction,
      port: 0,
    });
    servers.push(server);
    return { project, server, ...server.dashboard };
  }

  it("listens on 127.0.0.1 only", async () => {
    const { address } = await startDashboard();
    expect(address.address).toBe("127.0.0.1");
    expect(address.family).toBe("IPv4");
  }, 60_000);

  it("GET / is one HTML page: no external URLs, a strict CSP, the token, and no HTML insertion of data", async () => {
    const { url, token } = await startDashboard();
    const response = await fetch(url);
    const page = await response.text();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toMatch(/default-src 'none'; script-src 'nonce-[0-9a-f]+'/);
    expect(page).toContain(`<meta name="vika-token" content="${token}">`);
    expect(page).not.toMatch(/https?:\/\//); // no CDN, no external requests
    expect(page).not.toMatch(/\bsrc=|\bhref=/); // nothing loaded from anywhere
    expect(page).not.toMatch(HTML_INSERTION);
    expect(page).toContain("textContent");
    expect(page).toContain("vika run");
  }, 60_000);

  it("GET /api/report is the same object as `vika report --json`", async () => {
    const { url, project } = await startDashboard();
    const fromServer = (await (await fetch(`${url}api/report`)).json()) as Report;
    const fromCli = JSON.parse((await project.runVika(["report", "--json"])).output) as Report;
    expect(fromServer).toEqual(fromCli);
    expect(fromServer.schemaVersion).toBe(1);
    expect(fromServer.services[0]!.regressions).toHaveLength(1);
  }, 60_000);

  it("POST /api/tickets: 403 without the token, from another origin or another Host; with it, files exactly once", async () => {
    const fakeJira = createFakeJira([{ accountId: "acc-tomas", emailAddress: "tomas@example.com", displayName: "Tomas Ortega" }]);
    const { url, token, address } = await startDashboard({}, fakeJira);
    const ticketRequest = JSON.stringify({ service: "shopfront", deploySha: fixture.expected.badDeploySha });
    const post = (headers: Record<string, string>) => fetch(`${url}api/tickets`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: ticketRequest });

    expect((await post({})).status).toBe(403);
    expect((await post({ "X-Vika-Token": "0".repeat(64) })).status).toBe(403);
    expect((await post({ "X-Vika-Token": token, Origin: "https://evil.example" })).status).toBe(403);
    // DNS rebinding: a request for another host name, even with the token.
    expect((await sendRaw(address.port, "/api/report", { Host: `evil.example:${address.port}` })).status).toBe(403);
    expect(fakeJira.issues).toHaveLength(0);

    const created = await post({ "X-Vika-Token": token, Origin: `http://127.0.0.1:${address.port}` });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ status: "created", issueKey: "OPS-1", issueUrl: "https://example.atlassian.net/browse/OPS-1" });
    const again = await post({ "X-Vika-Token": token });
    expect(await again.json()).toMatchObject({ status: "already filed", issueKey: "OPS-1" });
    expect(fakeJira.issues).toHaveLength(1);

    // The tracker token never reaches the browser.
    const everythingServed = (await (await fetch(url)).text()) + (await (await fetch(`${url}api/report`)).text()) + (await (await fetch(`${url}api/settings`)).text());
    expect(everythingServed).not.toContain(JIRA_ENVIRONMENT.JIRA_API_TOKEN);
  }, 60_000);

  it("a regression whose log text contains <script> is only ever data, shown as text", async () => {
    const hostileLogPath = join(fixture.root, "hostile.log");
    writeFileSync(
      hostileLogPath,
      readFileSync(fixture.logPath, "utf8").replaceAll("TypeError: Cannot read properties of undefined (reading 'amount')", "TypeError: <script>alert(1)</script>"),
    );
    const { url } = await startDashboard({ logPath: hostileLogPath });
    const report = (await (await fetch(`${url}api/report`)).json()) as Report;
    expect(report.services[0]!.regressions[0]!.headline).toBe("TypeError: <script>alert(1)</script>");
    const page = await (await fetch(url)).text();
    expect(page).not.toContain("alert(1)"); // data never goes into the HTML...
    expect(page).not.toMatch(HTML_INSERTION); // ...and the page only ever sets it as text
  }, 60_000);

  it('with tracker "none": no ticket button (GitHub link only when the repo is on GitHub), and POST is refused', async () => {
    const { url, token } = await startDashboard({ trackerYamlLines: [], extraEnvironment: {} });
    expect(await (await fetch(`${url}api/settings`)).json()).toEqual({ trackerType: "none", gitHubNewIssueUrls: { shopfront: null } });
    const refused = await fetch(`${url}api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vika-Token": token },
      body: JSON.stringify({ service: "shopfront", deploySha: fixture.expected.badDeploySha }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toBe('tracker.type is "none" in vika.yaml, so no ticket can be filed');
  }, 60_000);

  it("`vika serve` says it is on 127.0.0.1 only, and shuts down cleanly", async () => {
    const project = await buildReportProject("direct", { fixture });
    projects.push(project);
    let output = "";
    const cliEnvironment = {
      writeOutput: (text: string) => (output += text),
      writeError: (text: string) => (output += text),
      isOutputTerminal: false,
      isInputTerminal: false,
      ask: async () => "",
      fetchFunction: createForbiddenFetch([]),
      environment: project.environment,
      workingDirectory: project.folder,
      clock: () => new Date(0),
      storeOptions: project.storeOptions,
      // Stops as soon as the server is up, like pressing Ctrl+C right away.
      waitForStopSignal: async () => {},
    };
    const exitCode = await runCli(["serve", "--port", "0"], cliEnvironment);
    expect(exitCode).toBe(0);
    expect(output).toMatch(/vika dashboard: http:\/\/127\.0\.0\.1:\d+\//);
    expect(output).toContain("Listening on 127.0.0.1 only");
    expect(output).toContain("Stopped.");

    output = "";
    await runCli(["serve", "--help"], cliEnvironment);
    expect(output.replace(/\s+/g, " ")).toContain("127.0.0.1 only (never 0.0.0.0)");
  }, 60_000);
});

describe("dashboard helpers", () => {
  it("request guard: Host must be ours, Origin ours when sent, POST needs the token", () => {
    const base = { method: "GET", host: "127.0.0.1:4173", origin: undefined, token: undefined, serverPort: 4173, expectedToken: "a".repeat(64) };
    expect(checkRequest(base)).toEqual({ isAllowed: true });
    expect(checkRequest({ ...base, host: "localhost:4173", origin: "http://localhost:4173" })).toEqual({ isAllowed: true });
    expect(checkRequest({ ...base, host: "evil.example:4173" }).isAllowed).toBe(false);
    expect(checkRequest({ ...base, host: "127.0.0.1:9999" }).isAllowed).toBe(false);
    expect(checkRequest({ ...base, origin: "http://evil.example" }).isAllowed).toBe(false);
    expect(checkRequest({ ...base, method: "POST" })).toEqual({ isAllowed: false, reason: "missing or wrong dashboard token; reload the page" });
    expect(checkRequest({ ...base, method: "POST", token: "a".repeat(64) })).toEqual({ isAllowed: true });
  });

  it("GitHub new-issue links only for github.com remotes", () => {
    expect(makeGitHubNewIssueUrl("https://github.com/acme/shop.git")).toBe("https://github.com/acme/shop/issues/new");
    expect(makeGitHubNewIssueUrl("git@github.com:acme/shop.git\n")).toBe("https://github.com/acme/shop/issues/new");
    expect(makeGitHubNewIssueUrl("ssh://git@github.com/acme/shop")).toBe("https://github.com/acme/shop/issues/new");
    expect(makeGitHubNewIssueUrl("https://gitlab.com/acme/shop.git")).toBeNull();
    expect(makeGitHubNewIssueUrl("/srv/git/shop")).toBeNull();
  });
});
