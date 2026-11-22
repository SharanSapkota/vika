// The Python fixture app: a small FastAPI shop run by gunicorn with uvicorn
// workers in Docker, with one seeded bug.
//
//   python-direct    the bug is on the crashing line (an order without a
//                    discount raises KeyError: 'discount')
//   python-indirect  get_user starts returning None; the crash is in its
//                    caller (email = user.email), whose line was written by
//                    an older, innocent commit, so blame points outside the
//                    deploy
//
// The log mixes the two line shapes a real Python backend writes (gunicorn
// lines and the app's own logger lines) with Python warnings that repeat all
// day, and puts a real traceback under every new ERROR line.
import {
  BACKGROUND_ERROR,
  FIRST_ERROR_DELAY_MS,
  LOG_END,
  LOG_START,
  MEI,
  PRIYA,
  TOMAS,
  lines,
  locate,
  type CommitPlan,
  type Deploy,
  type Fake,
  type FixtureApp,
  type FrameSpec,
  type LogEvent,
} from "./fixture-shared.js";

export const PYTHON_SCENARIOS = ["python-direct", "python-indirect"] as const;
export type PythonScenario = (typeof PYTHON_SCENARIOS)[number];

const NEW_ERROR: Record<PythonScenario, string> = {
  "python-direct": "KeyError: 'discount'",
  "python-indirect": "AttributeError: 'NoneType' object has no attribute 'email'",
};

// The warning PyJWT prints for a short key. It has no level word, repeats all
// day, and is never an error for vika.
export const PYTHON_WARNING_LINES = [
  "/usr/local/lib/python3.12/site-packages/jwt/api_jwt.py:370: InsecureKeyLengthWarning: The HMAC key is 14 bytes long, which is below the minimum recommended length of 32 bytes for SHA256. See RFC 7518 Section 3.2.",
  "  decoded = self.decode_complete(",
];

interface PythonAppState {
  orders: boolean; // src/shop/orders/service.py exists
  routes: boolean; // src/shop/api/routes.py exists
  validateEmail: boolean; // save_user checks the email
  readmeRunSection: boolean;
  ordersLogging: boolean; // create_order logs a line (shifts line numbers)
  discount: boolean; // DIRECT bug: total uses order["discount"]["amount"]
  nullableGetUser: boolean; // INDIRECT bug: get_user returns None instead of raising
  health: boolean; // health check route
  payments: boolean; // src/shop/payments/client.py exists
  version: string;
}

// Commit 7 is the seeded bug, as in the TypeScript app.
function commitPlan(scenario: PythonScenario): CommitPlan<PythonAppState>[] {
  return [
    { author: PRIYA, time: "2026-03-01T09:12:00Z", pr: 901, message: "Initial project setup",
      change: () => {}, deployAfter: "2026-03-01T10:00:00Z" },
    { author: PRIYA, time: "2026-03-02T11:05:00Z", pr: 903, message: "Add order service with totals",
      change: (s) => { s.orders = true; } },
    { author: TOMAS, time: "2026-03-02T14:40:00Z", pr: 904, message: "Add HTTP routes for orders and users",
      change: (s) => { s.routes = true; }, deployAfter: "2026-03-02T16:00:00Z" },
    { author: MEI, time: "2026-03-03T10:30:00Z", pr: 906, message: "Validate email format when saving users",
      change: (s) => { s.validateEmail = true; } },
    { author: TOMAS, time: "2026-03-04T13:15:00Z", pr: 907, message: "Document how to run locally",
      change: (s) => { s.readmeRunSection = true; }, deployAfter: "2026-03-04T15:30:00Z" },
    { author: MEI, time: "2026-03-05T10:20:00Z", pr: 909, message: "Log order creation",
      change: (s) => { s.ordersLogging = true; } },
    scenario === "python-direct"
      ? { author: TOMAS, time: "2026-03-06T11:20:00Z", pr: 912, message: "Apply order discounts to total",
          change: (s) => { s.discount = true; }, bad: true }
      : { author: TOMAS, time: "2026-03-06T11:20:00Z", pr: 912, message: "Return None from get_user instead of raising",
          change: (s) => { s.nullableGetUser = true; }, bad: true },
    { author: PRIYA, time: "2026-03-06T13:05:00Z", pr: 913, message: "Add health check route",
      change: (s) => { s.health = true; }, deployAfter: "2026-03-06T14:00:00Z" },
    { author: MEI, time: "2026-03-08T10:45:00Z", pr: 915, message: "Add payments client stub",
      change: (s) => { s.payments = true; } },
    { author: TOMAS, time: "2026-03-09T09:30:00Z", pr: 916, message: "Bump version to 1.1.0",
      change: (s) => { s.version = "1.1.0"; }, deployAfter: "2026-03-09T10:00:00Z" },
  ];
}

function renderApp(s: PythonAppState): Record<string, string> {
  const files: Record<string, string> = {
    "pyproject.toml": lines(
      "[project]",
      'name = "shopfront"',
      `version = "${s.version}"`,
      'requires-python = ">=3.12"',
      'dependencies = ["fastapi", "gunicorn", "uvicorn", "pyjwt"]',
    ),
    "README.md": lines(
      "# shopfront",
      "",
      "Small order service used by the storefront.",
      ...(s.readmeRunSection ? ["", "## Running locally", "", "    pip install -e .", "    gunicorn shop.main:app -k uvicorn.workers.UvicornWorker"] : []),
    ),
    "src/shop/__init__.py": "",
    "src/shop/users/__init__.py": "",
    "src/shop/users/repo.py": lines(
      '"""In-memory user repository."""',
      "from dataclasses import dataclass",
      "",
      "",
      "@dataclass",
      "class User:",
      "    id: str",
      "    email: str",
      "    name: str",
      "",
      "",
      "_users: dict[str, User] = {}",
      "",
      "",
      "def save_user(user: User) -> None:",
      ...(s.validateEmail ? ['    if "@" not in user.email:', '        raise ValueError(f"invalid email for user {user.id}")'] : []),
      "    _users[user.id] = user",
      "",
      "",
      ...(s.nullableGetUser
        ? [
            "def get_user(user_id: str) -> User | None:",
            '    """Returns None when the user does not exist."""',
            "    return _users.get(user_id)",
          ]
        : [
            "def get_user(user_id: str) -> User:",
            "    user = _users.get(user_id)",
            "    if user is None:",
            '        raise LookupError(f"user {user_id} not found")',
            "    return user",
          ]),
    ),
  };

  if (s.orders) {
    files["src/shop/orders/__init__.py"] = "";
    files["src/shop/orders/service.py"] = lines(
      '"""Order service: creates orders and computes totals."""',
      ...(s.ordersLogging ? ["import logging", ""] : []),
      "from shop.users.repo import get_user",
      "",
      ...(s.ordersLogging ? ['logger = logging.getLogger("server")', ""] : []),
      "",
      "class OrderService:",
      "    def create_order(self, order: dict) -> dict:",
      ...(s.ordersLogging ? ['        logger.info("creating order %s", order["id"])'] : []),
      '        user = get_user(order["user_id"])',
      "        email = user.email",
      s.discount
        ? '        total = sum(item["price"] * item["qty"] for item in order["items"]) - order["discount"]["amount"]'
        : '        total = sum(item["price"] * item["qty"] for item in order["items"])',
      '        return {"id": order["id"], "total": total, "email": email}',
    );
  }

  if (s.routes) {
    files["src/shop/api/__init__.py"] = "";
    files["src/shop/api/routes.py"] = lines(
      '"""HTTP routes. Each one turns a request into a service call."""',
      "from fastapi import APIRouter",
      "",
      "from shop.orders.service import OrderService",
      "from shop.users.repo import get_user",
      "",
      "router = APIRouter()",
      "orders = OrderService()",
      "",
      "",
      '@router.post("/api/orders", status_code=201)',
      "async def create_order_route(order: dict) -> dict:",
      "    return orders.create_order(order)",
      "",
      "",
      '@router.get("/api/users/{user_id}")',
      "async def get_user_route(user_id: str) -> dict:",
      "    return vars(get_user(user_id))",
      ...(s.health ? ["", "", '@router.get("/health")', "async def health() -> dict:", '    return {"ok": True}'] : []),
    );
  }

  if (s.payments) {
    files["src/shop/payments/__init__.py"] = "";
    files["src/shop/payments/client.py"] = lines(
      '"""Placeholder client for the payments provider."""',
      "",
      "",
      "async def charge(order_id: str, amount: float) -> dict:",
      "    del order_id, amount",
      '    return {"ok": True}',
    );
  }

  return files;
}

// ---------------------------------------------------------------------------
// Log lines in the shapes of the real samples
// ---------------------------------------------------------------------------

// `2026-11-21 19:17:57,987 - server - INFO - message` (the app's logger).
function loggerLine(at: number, level: string, message: string): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)},${iso.slice(20, 23)} - server - ${level} - ${message}`;
}

// `[2026-11-21 19:17:52 +0000] [7] [INFO] message` (gunicorn and uvicorn).
function gunicornLine(at: number, processId: number, level: string, message: string): string {
  const iso = new Date(at).toISOString();
  return `[${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000] [${processId}] [${level}] ${message}`;
}

// The app frames for each scenario, crashing call first.
function frameSpecs(scenario: PythonScenario): FrameSpec[] {
  const top: FrameSpec =
    scenario === "python-direct"
      ? { fn: "create_order", file: "src/shop/orders/service.py", lineText: 'order["discount"]["amount"]', colText: 'order["discount"]' }
      : { fn: "create_order", file: "src/shop/orders/service.py", lineText: "email = user.email", colText: "user.email" };
  return [top, { fn: "create_order_route", file: "src/shop/api/routes.py", lineText: "return orders.create_order(order)", colText: "orders.create_order(order)" }];
}

// A real-looking traceback: Python prints the OLDEST call first, so the two
// library frames come first and the crashing app frame comes last. Each
// frame has its source line and, as Python 3.12 does, a "^^^^" marker line.
function traceback(readFileAtSha: (sha: string, path: string) => string, sha: string, scenario: PythonScenario): string {
  const appFrameLines = frameSpecs(scenario).map((spec) => {
    const fileContent = readFileAtSha(sha, spec.file);
    const { line, col } = locate(fileContent, spec);
    const sourceLine = fileContent.split("\n")[line - 1]!;
    const strippedLine = sourceLine.trim();
    const markerOffset = col - 1 - (sourceLine.length - sourceLine.trimStart().length);
    return [
      `  File "/app/${spec.file}", line ${line}, in ${spec.fn}`,
      `    ${strippedLine}`,
      `    ${" ".repeat(markerOffset)}${"^".repeat(spec.colText.length)}`,
    ].join("\n");
  });
  return [
    "Traceback (most recent call last):",
    '  File "/usr/local/lib/python3.12/site-packages/starlette/routing.py", line 74, in app',
    "    response = await f(request)",
    "               ^^^^^^^^^^^^^^^^",
    '  File "/usr/local/lib/python3.12/site-packages/fastapi/routing.py", line 301, in app',
    "    raw_response = await run_endpoint_function(",
    "                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
    ...appFrameLines.reverse(),
    NEW_ERROR[scenario],
  ].join("\n");
}

function buildLog(fake: Fake, deploys: Deploy[], badDeploy: Deploy, trace: string): { text: string; firstSeen: string } {
  const events: LogEvent[] = [];
  const ms = () => fake.int(0, 999);

  // gunicorn starts at the beginning of the log and after every deploy.
  const startServer = (at: number) => {
    events.push({ at, text: gunicornLine(at, 1, "INFO", "Starting gunicorn 27.0.0") });
    events.push({ at: at + 1, text: gunicornLine(at + 1, 7, "INFO", "Booting worker with pid: 7") });
    events.push({ at: at + 2, text: gunicornLine(at + 2, 8, "INFO", "Booting worker with pid: 8") });
    events.push({ at: at + 3000, text: loggerLine(at + 3000, "INFO", "Cloudinary reachable") });
    events.push({ at: at + 9000, text: gunicornLine(at + 9000, 8, "INFO", "Application startup complete.") });
  };
  startServer(LOG_START + 1000);
  for (const deploy of deploys) startServer(Date.parse(deploy.time) + 5000);

  // Normal INFO traffic every 1-4 minutes, with changing IDs, IPs and emails.
  for (let at = LOG_START + fake.int(15, 60) * 1000; at < LOG_END; at += fake.int(60, 240) * 1000 + ms()) {
    const kind = fake.int(0, 3);
    const text =
      kind === 0
        ? loggerLine(at, "INFO", `GET /api/orders/${fake.orderId()} 200 ${fake.int(8, 120)}ms user=${fake.userId()} ip=${fake.ip()} request_id=${fake.uuid()}`)
        : kind === 1
          ? loggerLine(at, "INFO", `POST /api/orders 201 ${fake.int(20, 300)}ms user=${fake.userId()} ip=${fake.ip()} request_id=${fake.uuid()}`)
          : kind === 2
            ? loggerLine(at, "INFO", `User ${fake.email()} logged in from ${fake.ip()} session=${fake.uuid()}`)
            : loggerLine(at, "INFO", `Backfilled location on ${fake.int(1, 20)} products`);
    events.push({ at, text });
  }

  // The PyJWT warning, every 2-5 hours all through the log. No timestamp.
  for (let at = LOG_START + fake.int(600, 3600) * 1000; at < LOG_END; at += fake.int(2 * 3600, 5 * 3600) * 1000 + ms()) {
    events.push({ at, text: PYTHON_WARNING_LINES.join("\n") });
  }

  // Background error: a few times every day, plus once 30 minutes before and
  // after every deploy, so it is clearly present on both sides of each deploy.
  const background = (at: number) =>
    events.push({ at, text: loggerLine(at, "ERROR", `${BACKGROUND_ERROR} query=select_orders_by_user user=${fake.userId()} request_id=${fake.uuid()}`) });
  for (let day = LOG_START; day < LOG_END; day += 24 * 3600 * 1000) {
    const count = fake.int(3, 6);
    for (let index = 0; index < count; index++) background(day + fake.int(0, 24 * 3600 - 1) * 1000 + ms());
  }
  for (const deploy of deploys) {
    const deployTime = Date.parse(deploy.time);
    background(deployTime - 30 * 60 * 1000 - fake.int(0, 300) * 1000);
    background(deployTime + 30 * 60 * 1000 + fake.int(0, 300) * 1000);
  }

  // The new error: first seen about 4 minutes after the bad deploy, then
  // repeating every 5-60 minutes. The app logs it with logger.exception, so
  // the traceback follows the ERROR line.
  const firstAt = Date.parse(badDeploy.time) + FIRST_ERROR_DELAY_MS;
  for (let at = firstAt; at < LOG_END; at += fake.int(5 * 60, 60 * 60) * 1000 + ms()) {
    const header = loggerLine(at, "ERROR", `POST /api/orders failed user=${fake.userId()} ip=${fake.ip()} request_id=${fake.uuid()}`);
    events.push({ at, text: `${header}\n${trace}` });
  }

  // Sort by time. Ties keep insertion order (Array.sort is stable).
  events.sort((left, right) => left.at - right.at);
  return { text: events.map((event) => event.text).join("\n") + "\n", firstSeen: new Date(firstAt).toISOString() };
}

export function buildPythonFixtureApp(scenario: PythonScenario): FixtureApp<PythonAppState> {
  return {
    language: "python",
    initialState: {
      orders: false, routes: false, validateEmail: false, readmeRunSection: false, ordersLogging: false,
      discount: false, nullableGetUser: false, health: false, payments: false, version: "1.0.0",
    },
    commitPlans: commitPlan(scenario),
    renderApp,
    randomSeed: scenario === "python-direct" ? 912 : 913,
    buildLog: (fake, deploys, badDeploy, readFileAtSha) => buildLog(fake, deploys, badDeploy, traceback(readFileAtSha, badDeploy.sha, scenario)),
  };
}
