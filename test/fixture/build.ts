// Builds a fake company with a KNOWN answer, for testing vika.
//
// In a temp folder OUTSIDE this project it writes:
//   repo/          a small git repo (~10 commits) with one seeded bug, in
//                  TypeScript (direct, indirect) or Python (python-direct,
//                  python-indirect; see python-fixture-app.ts)
//   deploys.json   the deploy timeline: [{ sha, time, previousSha }]
//   app.log        ~10 days of logs: normal traffic, a constant background
//                  error, and one new error that starts after the bad deploy
//   expected.json  the correct answer (suspect commit, author, PR, ...)
//
// Everything is deterministic: seeded random numbers, fixed dates, and git
// isolated from the user's own config. Building twice gives identical output.
//
// Usage: npx tsx test/fixture/build.ts [direct|indirect|python-direct|python-indirect] [branchName]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Fake,
  LOG_END,
  LOG_START,
  FIRST_ERROR_DELAY_MS,
  BACKGROUND_ERROR,
  MEI,
  PRIYA,
  TOMAS,
  lines,
  locate,
  makeRandom,
  type CommitPlan,
  type Deploy,
  type FixtureApp,
  type FrameSpec,
  type LogEvent,
} from "./fixture-shared.js";
import { PYTHON_SCENARIOS, buildPythonFixtureApp, type PythonScenario } from "./python-fixture-app.js";

export { BACKGROUND_ERROR, type Deploy } from "./fixture-shared.js";

export type JavascriptScenario = "direct" | "indirect";
export type Scenario = JavascriptScenario | PythonScenario;
export const SCENARIOS: readonly Scenario[] = ["direct", "indirect", ...PYTHON_SCENARIOS];

export interface Expected {
  scenario: Scenario;
  language: "javascript" | "python";
  productionBranch: string;
  badDeploySha: string;
  previousSha: string; // the deploy before the bad one
  suspectSha: string;
  suspectAuthor: string;
  suspectEmail: string;
  suspectPr: number;
  errorFirstSeen: string; // ISO timestamp
}

export interface FixtureOptions {
  branchName?: string; // production branch name, default "main"
}

export interface Fixture {
  root: string;
  branchName: string;
  repoDir: string;
  logPath: string;
  deploysPath: string;
  expectedPath: string;
  deploys: Deploy[];
  expected: Expected;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NEW_ERROR: Record<JavascriptScenario, string> = {
  direct: "TypeError: Cannot read properties of undefined (reading 'amount')",
  indirect: "TypeError: Cannot read properties of null (reading 'email')",
};

interface AppState {
  orders: boolean; // src/orders/service.ts exists
  handlers: boolean; // src/api/handlers.ts exists
  validateEmail: boolean; // saveUser checks the email
  readmeRunSection: boolean;
  ordersLogging: boolean; // createOrder logs a line (shifts line numbers)
  discount: boolean; // DIRECT bug: total uses order.discount.amount
  nullableGetUser: boolean; // INDIRECT bug: getUser returns null instead of throwing
  health: boolean; // health check handler
  payments: boolean; // src/payments/client.ts exists
  version: string;
}

// Commit 7 is the seeded bug. Its content depends on the scenario.
function commitPlan(scenario: JavascriptScenario): CommitPlan<AppState>[] {
  return [
    { author: PRIYA, time: "2026-03-01T09:12:00Z", pr: 801, message: "Initial project setup",
      change: () => {}, deployAfter: "2026-03-01T10:00:00Z" },
    { author: PRIYA, time: "2026-03-02T11:05:00Z", pr: 803, message: "Add order service with totals",
      change: (s) => { s.orders = true; } },
    { author: TOMAS, time: "2026-03-02T14:40:00Z", pr: 804, message: "Add HTTP handlers for orders and users",
      change: (s) => { s.handlers = true; }, deployAfter: "2026-03-02T16:00:00Z" },
    { author: MEI, time: "2026-03-03T10:30:00Z", pr: 806, message: "Validate email format when saving users",
      change: (s) => { s.validateEmail = true; } },
    { author: TOMAS, time: "2026-03-04T13:15:00Z", pr: 807, message: "Document how to run locally",
      change: (s) => { s.readmeRunSection = true; }, deployAfter: "2026-03-04T15:30:00Z" },
    { author: MEI, time: "2026-03-05T10:20:00Z", pr: 809, message: "Log order creation",
      change: (s) => { s.ordersLogging = true; } },
    scenario === "direct"
      ? { author: TOMAS, time: "2026-03-06T11:20:00Z", pr: 812, message: "Apply order discounts to total",
          change: (s) => { s.discount = true; }, bad: true }
      : { author: TOMAS, time: "2026-03-06T11:20:00Z", pr: 812, message: "Return null from getUser instead of throwing",
          change: (s) => { s.nullableGetUser = true; }, bad: true },
    { author: PRIYA, time: "2026-03-06T13:05:00Z", pr: 813, message: "Add health check endpoint",
      change: (s) => { s.health = true; }, deployAfter: "2026-03-06T14:00:00Z" },
    { author: MEI, time: "2026-03-08T10:45:00Z", pr: 815, message: "Add payments client stub",
      change: (s) => { s.payments = true; } },
    { author: TOMAS, time: "2026-03-09T09:30:00Z", pr: 816, message: "Bump version to 1.1.0",
      change: (s) => { s.version = "1.1.0"; }, deployAfter: "2026-03-09T10:00:00Z" },
  ];
}

// ---------------------------------------------------------------------------
// The fake app's source files
// ---------------------------------------------------------------------------

function renderApp(s: AppState): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "shopfront", version: s.version, type: "module" }, null, 2) + "\n",
    "README.md": lines(
      "# shopfront",
      "",
      "Small order service used by the storefront.",
      ...(s.readmeRunSection ? ["", "## Running locally", "", "    npm install", "    npm start"] : []),
    ),
    "src/log.ts": lines(
      "// Tiny logger that writes one line per message.",
      "export const log = {",
      "  info(message: string): void {",
      "    console.log(`${new Date().toISOString()} INFO  ${message}`);",
      "  },",
      "  error(message: string): void {",
      "    console.error(`${new Date().toISOString()} ERROR ${message}`);",
      "  },",
      "};",
    ),
    "src/users/repo.ts": lines(
      "// In-memory user repository.",
      "export interface User {",
      "  id: string;",
      "  email: string;",
      "  name: string;",
      "}",
      "",
      "const users = new Map<string, User>();",
      "",
      "export function saveUser(user: User): void {",
      ...(s.validateEmail ? ['  if (!user.email.includes("@")) throw new Error(`invalid email for user ${user.id}`);'] : []),
      "  users.set(user.id, user);",
      "}",
      "",
      ...(s.nullableGetUser
        ? [
            "// Returns null when the user does not exist.",
            "export function getUser(id: string): User | null {",
            "  return users.get(id) ?? null;",
            "}",
          ]
        : [
            "export function getUser(id: string): User {",
            "  const user = users.get(id);",
            "  if (!user) throw new Error(`user ${id} not found`);",
            "  return user;",
            "}",
          ]),
    ),
  };

  if (s.orders) {
    files["src/orders/service.ts"] = lines(
      "// Order service: creates orders and computes totals.",
      ...(s.ordersLogging ? ['import { log } from "../log.js";'] : []),
      'import { getUser } from "../users/repo.js";',
      "",
      "export interface OrderItem {",
      "  sku: string;",
      "  price: number;",
      "  qty: number;",
      "}",
      "",
      "export interface Order {",
      "  id: string;",
      "  userId: string;",
      "  items: OrderItem[];",
      ...(s.discount ? ["  discount: { code: string; amount: number };"] : []),
      "}",
      "",
      "export function createOrder(order: Order): { id: string; total: number; email: string } {",
      ...(s.ordersLogging ? ["  log.info(`creating order ${order.id}`);"] : []),
      "  const user = getUser(order.userId);",
      "  const email = user.email;",
      s.discount
        ? "  const total = order.items.reduce((sum, item) => sum + item.price * item.qty, 0) - order.discount.amount;"
        : "  const total = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);",
      "  return { id: order.id, total, email };",
      "}",
    );
  }

  if (s.handlers) {
    files["src/api/handlers.ts"] = lines(
      "// HTTP handlers. Each one turns a request into a service call.",
      'import { createOrder, type Order } from "../orders/service.js";',
      'import { getUser } from "../users/repo.js";',
      "",
      "export interface Request {",
      "  body: unknown;",
      "  params: Record<string, string>;",
      "}",
      "",
      "export interface Response {",
      "  status(code: number): Response;",
      "  json(data: unknown): void;",
      "}",
      "",
      "export function handleCreateOrder(req: Request, res: Response): void {",
      "  const result = createOrder(req.body as Order);",
      "  res.status(201).json(result);",
      "}",
      "",
      "export function handleGetUser(req: Request, res: Response): void {",
      '  const user = getUser(req.params.id ?? "");',
      "  res.status(200).json(user);",
      "}",
      ...(s.health
        ? ["", "export function handleHealth(_req: Request, res: Response): void {", '  res.status(200).json({ ok: true });', "}"]
        : []),
    );
  }

  if (s.payments) {
    files["src/payments/client.ts"] = lines(
      "// Placeholder client for the payments provider.",
      "export async function charge(orderId: string, amount: number): Promise<{ ok: boolean }> {",
      "  void orderId;",
      "  void amount;",
      "  return { ok: true };",
      "}",
    );
  }

  return files;
}

// ---------------------------------------------------------------------------
// Git helpers (always scoped to the fake repo)
// ---------------------------------------------------------------------------

// Environment for git: drops any GIT_* variables we inherited (for example from
// a git hook) and ignores the user's global/system config, so commits can only
// land in the fake repo and SHAs are reproducible.
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
}

// Runs git inside the fake repo and returns its trimmed output.
export function git(repoDir: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd: repoDir, env: gitEnv(extraEnv), encoding: "utf8" }).trim();
}

// Git's raw date format: "<unix seconds> +0000".
function gitDate(iso: string): string {
  return `${Math.floor(Date.parse(iso) / 1000)} +0000`;
}

// Throws unless `path` is outside this project.
function assertOutsideProject(path: string): void {
  const rel = relative(realpathSync(PROJECT_ROOT), realpathSync(path));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`refusing to build fixture inside the project: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Log generation
// ---------------------------------------------------------------------------

function logLine(at: number, level: string, component: string, message: string): string {
  return `${new Date(at).toISOString()} ${level.padEnd(5)} [${component}] ${message}`;
}

// The app frames for each scenario, innermost first.
function frameSpecs(scenario: JavascriptScenario): FrameSpec[] {
  const top: FrameSpec =
    scenario === "direct"
      ? { fn: "createOrder", file: "src/orders/service.ts", lineText: "order.discount.amount", colText: "amount;" }
      : { fn: "createOrder", file: "src/orders/service.ts", lineText: "const email = user.email;", colText: "email;" };
  return [
    top,
    { fn: "handleCreateOrder", file: "src/api/handlers.ts", lineText: "createOrder(req.body as Order)", colText: "createOrder(req" },
  ];
}

// Builds the stack trace text, with line numbers read from the repo at `sha`.
function stackTrace(readFileAtSha: (sha: string, path: string) => string, sha: string, scenario: JavascriptScenario): string {
  const appFrames = frameSpecs(scenario).map((spec) => {
    const { line, col } = locate(readFileAtSha(sha, spec.file), spec);
    return `    at ${spec.fn} (/app/${spec.file}:${line}:${col})`;
  });
  return [
    NEW_ERROR[scenario],
    ...appFrames,
    "    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)",
    "    at next (/app/node_modules/express/lib/router/route.js:149:13)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
  ].join("\n");
}

function buildLog(fake: Fake, deploys: Deploy[], badDeploy: Deploy, trace: string): { text: string; firstSeen: string } {
  const events: LogEvent[] = [];
  const ms = () => fake.int(0, 999);

  // Normal INFO traffic every 1-4 minutes, with changing IDs, IPs and emails.
  for (let at = LOG_START + fake.int(5, 60) * 1000; at < LOG_END; at += fake.int(60, 240) * 1000 + ms()) {
    const kind = fake.int(0, 4);
    const text =
      kind === 0
        ? logLine(at, "INFO", "api", `GET /api/orders/${fake.orderId()} 200 ${fake.int(8, 120)}ms user=${fake.userId()} ip=${fake.ip()} request_id=${fake.uuid()}`)
        : kind === 1
          ? logLine(at, "INFO", "api", `POST /api/orders 201 ${fake.int(20, 300)}ms user=${fake.userId()} ip=${fake.ip()} request_id=${fake.uuid()}`)
          : kind === 2
            ? logLine(at, "INFO", "auth", `User ${fake.email()} logged in from ${fake.ip()} session=${fake.uuid()}`)
            : kind === 3
              ? logLine(at, "INFO", "mail", `Sent receipt to ${fake.email()} for order ${fake.orderId()}`)
              : logLine(at, "INFO", "api", `GET /api/users/${fake.userId()} 200 ${fake.int(5, 60)}ms ip=${fake.ip()} request_id=${fake.uuid()}`);
    events.push({ at, text });
  }

  // Background error: a few times every day, plus once 30 minutes before and
  // after every deploy, so it is clearly present on both sides of each deploy.
  const background = (at: number) =>
    events.push({
      at,
      text: logLine(at, "ERROR", "db", `${BACKGROUND_ERROR} query=select_orders_by_user user=${fake.userId()} request_id=${fake.uuid()}`),
    });
  for (let day = LOG_START; day < LOG_END; day += 24 * 3600 * 1000) {
    const count = fake.int(3, 6);
    for (let i = 0; i < count; i++) background(day + fake.int(0, 24 * 3600 - 1) * 1000 + ms());
  }
  for (const d of deploys) {
    const t = Date.parse(d.time);
    background(t - 30 * 60 * 1000 - fake.int(0, 300) * 1000);
    background(t + 30 * 60 * 1000 + fake.int(0, 300) * 1000);
  }

  // The new error: first seen about 4 minutes after the bad deploy, then
  // repeating every 5-60 minutes until the end of the log.
  const firstAt = Date.parse(badDeploy.time) + FIRST_ERROR_DELAY_MS;
  for (let at = firstAt; at < LOG_END; at += fake.int(5 * 60, 60 * 60) * 1000 + ms()) {
    const header = logLine(at, "ERROR", "api", `POST /api/orders failed user=${fake.userId()} ip=${fake.ip()} request_id=${fake.uuid()}`);
    events.push({ at, text: `${header}\n${trace}` });
  }

  // Sort by time. Ties keep insertion order (Array.sort is stable).
  events.sort((a, b) => a.at - b.at);
  return { text: events.map((e) => e.text).join("\n") + "\n", firstSeen: new Date(firstAt).toISOString() };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// The TypeScript app. Its seeds (812, 813) and content never change, so the
// JavaScript fixtures stay byte-identical.
function buildJavascriptFixtureApp(scenario: JavascriptScenario): FixtureApp<AppState> {
  return {
    language: "javascript",
    initialState: {
      orders: false, handlers: false, validateEmail: false, readmeRunSection: false, ordersLogging: false,
      discount: false, nullableGetUser: false, health: false, payments: false, version: "1.0.0",
    },
    commitPlans: commitPlan(scenario),
    renderApp,
    randomSeed: scenario === "direct" ? 812 : 813,
    buildLog: (fake, deploys, badDeploy, readFileAtSha) => buildLog(fake, deploys, badDeploy, stackTrace(readFileAtSha, badDeploy.sha, scenario)),
  };
}

const isPythonScenario = (scenario: Scenario): scenario is PythonScenario => (PYTHON_SCENARIOS as readonly string[]).includes(scenario);

// Builds one scenario in a new temp folder and returns its paths and the answer.
// The caller is responsible for deleting `root` when done.
export function buildFixture(scenario: Scenario, options: FixtureOptions = {}): Fixture {
  return isPythonScenario(scenario)
    ? buildFixtureFromApp(scenario, buildPythonFixtureApp(scenario), options)
    : buildFixtureFromApp(scenario, buildJavascriptFixtureApp(scenario), options);
}

function buildFixtureFromApp<State>(scenario: Scenario, app: FixtureApp<State>, options: FixtureOptions): Fixture {
  const branchName = options.branchName ?? "main";
  const root = mkdtempSync(join(tmpdir(), `vika-fixture-${scenario}-`));
  assertOutsideProject(root);

  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  git(repoDir, ["init", "-q", "-b", branchName]);

  // Safety check: git must see the fake repo as its own top level, not this project.
  if (realpathSync(git(repoDir, ["rev-parse", "--show-toplevel"])) !== realpathSync(repoDir)) {
    throw new Error("fixture repo is not isolated; refusing to commit");
  }

  // Make the commits, recording deploys as we go.
  const state: State = structuredClone(app.initialState);
  const deploys: Deploy[] = [];
  let badCommit: { sha: string; plan: CommitPlan<State> } | undefined;
  let badDeploy: Deploy | undefined;

  for (const plan of app.commitPlans) {
    plan.change(state);
    for (const [path, content] of Object.entries(app.renderApp(state))) {
      mkdirSync(dirname(join(repoDir, path)), { recursive: true });
      writeFileSync(join(repoDir, path), content);
    }
    git(repoDir, ["add", "-A"]);
    // No signing and no hooks, so the user's setup can't change the SHAs.
    git(repoDir, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", `${plan.message} (#${plan.pr})`], {
      GIT_AUTHOR_NAME: plan.author.name,
      GIT_AUTHOR_EMAIL: plan.author.email,
      GIT_AUTHOR_DATE: gitDate(plan.time),
      GIT_COMMITTER_NAME: plan.author.name,
      GIT_COMMITTER_EMAIL: plan.author.email,
      GIT_COMMITTER_DATE: gitDate(plan.time),
    });
    const sha = git(repoDir, ["rev-parse", "HEAD"]);

    if (plan.bad) badCommit = { sha, plan };
    if (plan.deployAfter) {
      const deploy: Deploy = {
        sha,
        time: new Date(plan.deployAfter).toISOString(),
        previousSha: deploys.at(-1)?.sha ?? null,
      };
      deploys.push(deploy);
      // The bad deploy is the first one that ships the bad commit.
      if (badCommit && !badDeploy) badDeploy = deploy;
    }
  }
  if (!badCommit || !badDeploy?.previousSha) throw new Error("fixture bug: no bad commit or bad deploy");

  // Logs, with the stack trace pointing at real lines at the bad deploy's sha.
  const fake = new Fake(makeRandom(app.randomSeed));
  const log = app.buildLog(fake, deploys, badDeploy, (sha, path) => git(repoDir, ["show", `${sha}:${path}`]));

  const expected: Expected = {
    scenario,
    language: app.language,
    productionBranch: branchName,
    badDeploySha: badDeploy.sha,
    previousSha: badDeploy.previousSha,
    suspectSha: badCommit.sha,
    suspectAuthor: badCommit.plan.author.name,
    suspectEmail: badCommit.plan.author.email,
    suspectPr: badCommit.plan.pr,
    errorFirstSeen: log.firstSeen,
  };

  const logPath = join(root, "app.log");
  const deploysPath = join(root, "deploys.json");
  const expectedPath = join(root, "expected.json");
  writeFileSync(logPath, log.text);
  writeFileSync(deploysPath, JSON.stringify(deploys, null, 2) + "\n");
  writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + "\n");

  return { root, branchName, repoDir, logPath, deploysPath, expectedPath, deploys, expected };
}

// When run as a script, build the given scenario and print where it went.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const scenario = SCENARIOS.find((candidate) => candidate === (process.argv[2] ?? "direct"));
  if (scenario === undefined) {
    console.error(`usage: tsx test/fixture/build.ts [${SCENARIOS.join("|")}] [branchName]`);
    process.exit(1);
  }
  const fixture = buildFixture(scenario, { branchName: process.argv[3] });
  console.log(JSON.stringify({ ...fixture, deploys: undefined }, null, 2));
}
