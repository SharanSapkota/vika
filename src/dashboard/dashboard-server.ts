
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { hideSecrets } from "../configuration/hide-secrets.js";
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import type { Store } from "../database/store-types.js";
import { buildStoredReport } from "../pipeline/build-stored-report.js";
import { prepareTicketDrafts } from "../pipeline/prepare-ticket-drafts.js";
import { createTracker } from "../ticket-trackers/create-tracker.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";
import { createTicket } from "../ticketing/create-ticket.js";
import { describeOutcome } from "../ticketing/describe-ticket-outcome.js";
import { makeContentSecurityPolicy, renderDashboardPage } from "./dashboard-page.js";
import { readGitHubNewIssueUrl } from "./github-issue-link.js";
import { checkRequest, TOKEN_HEADER } from "./request-guard.js";

export const DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4173;
const MAX_REQUEST_BODY_BYTES = 10_000;

const ticketRequestSchema = z.strictObject({ service: z.string(), deploySha: z.string() });

export interface DashboardServerOptions {
  configuration: LoadedConfiguration;
  store: Store;
  fetchFunction: FetchFunction;
  secrets: string[];
  port: number; // 0 picks a free port (tests)
}

export interface RunningDashboard {
  address: AddressInfo; // always 127.0.0.1
  url: string;
  token: string;
  close(): Promise<void>;
}

class RequestError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_REQUEST_BODY_BYTES) throw new RequestError(413, "request too large");
  }
  return body;
}

function sendJson(response: ServerResponse, httpStatus: number, value: unknown): void {
  response.writeHead(httpStatus, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<RunningDashboard> {
  const { configuration, store, secrets } = options;
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const tracker = createTracker(configuration, options.fetchFunction, secrets);
  let serverPort = options.port;

  async function fileTicket(requestBody: string): Promise<{ httpStatus: number; answer: Record<string, unknown> }> {
    let ticketRequest: z.infer<typeof ticketRequestSchema>;
    try {
      ticketRequest = ticketRequestSchema.parse(JSON.parse(requestBody));
    } catch {
      return { httpStatus: 400, answer: { status: "bad request", message: "send JSON like { \"service\": \"api\", \"deploySha\": \"...\" }" } };
    }
    if (tracker === null) {
      return { httpStatus: 400, answer: { status: "no tracker configured", message: 'tracker.type is "none" in vika.yaml, so no ticket can be filed' } };
    }
    const report = await buildStoredReport(store, configuration);
    const draft = (await prepareTicketDrafts(store, configuration, report)).find(
      (candidate) => candidate.service === ticketRequest.service && candidate.deploySha === ticketRequest.deploySha,
    );
    if (draft === undefined) {
      return { httpStatus: 404, answer: { status: "no draft", message: "that deploy has no medium or high regression, so there is nothing to file" } };
    }
    const outcome = await createTicket({ store, tracker, draft, secrets });
    const answer: Record<string, unknown> = { status: outcome.status, message: describeOutcome(outcome) };
    if ("issueKey" in outcome) Object.assign(answer, { issueKey: outcome.issueKey, issueUrl: outcome.issueUrl });
    return { httpStatus: outcome.status === "failed" ? 502 : 200, answer };
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const decision = checkRequest({
      method: request.method ?? "GET",
      host: request.headers.host,
      origin: request.headers.origin,
      token: request.headers[TOKEN_HEADER] as string | undefined,
      serverPort,
      expectedToken: token,
    });
    if (!decision.isAllowed) return sendJson(response, 403, { status: "refused", message: decision.reason });

    const path = new URL(request.url ?? "/", `http://${DASHBOARD_HOST}`).pathname;
    if (request.method === "GET" && path === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": makeContentSecurityPolicy(nonce),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(renderDashboardPage(token, nonce));
      return;
    }
    if (request.method === "GET" && path === "/api/report") return sendJson(response, 200, await buildStoredReport(store, configuration));
    if (request.method === "GET" && path === "/api/settings") {
      const gitHubNewIssueUrls: Record<string, string | null> = {};
      for (const [serviceName, serviceSettings] of Object.entries(configuration.services)) {
        gitHubNewIssueUrls[serviceName] = tracker === null ? await readGitHubNewIssueUrl(serviceSettings.repo) : null;
      }
      return sendJson(response, 200, { trackerType: configuration.tracker.type, gitHubNewIssueUrls });
    }
    if (request.method === "POST" && path === "/api/tickets") {
      const { httpStatus, answer } = await fileTicket(await readBody(request));
      return sendJson(response, httpStatus, answer);
    }
    sendJson(response, 404, { status: "not found", message: `nothing at ${request.method} ${path}` });
  }

  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      const httpStatus = error instanceof RequestError ? error.httpStatus : 500;
      const message = hideSecrets(error instanceof Error ? error.message : String(error), secrets);
      if (!response.headersSent) sendJson(response, httpStatus, { status: "error", message });
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, DASHBOARD_HOST, () => resolve());
  });
  const address = server.address() as AddressInfo;
  serverPort = address.port;

  return {
    address,
    url: `http://${DASHBOARD_HOST}:${address.port}/`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
