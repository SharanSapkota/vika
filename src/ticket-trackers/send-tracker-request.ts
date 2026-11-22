// Sends one HTTP request to a tracker and turns every failure into a
// plain-English TrackerError. Shared by the Jira and Linear clients.
//
// - Every request has a timeout.
// - Nothing is retried, ever: a retried "create issue" whose first attempt
//   actually succeeded would file a duplicate ticket.
// - Error messages never contain the token. The request headers are never
//   echoed, and any text from the tracker is masked with the known secrets.
import { hideSecrets } from "../configuration/hide-secrets.js";
import type { FetchFunction } from "./tracker-types.js";

export class TrackerError extends Error {
  readonly httpStatus: number | null;

  constructor(message: string, httpStatus: number | null) {
    super(message);
    this.name = "TrackerError";
    this.httpStatus = httpStatus;
  }
}

export interface TrackerRequest {
  trackerName: string; // "Jira", "Linear": used in messages
  credentialsHint: string; // which settings to check on 401/403
  fetchFunction: FetchFunction;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown; // sent as JSON
  timeoutMs: number;
  secrets: string[]; // masked out of any text the tracker sends back
}

const MAX_DETAIL_LENGTH = 200;

// A short, masked piece of the tracker's own error text, if it has one.
function summarizeErrorBody(responseText: string, secrets: string[]): string {
  let detail = responseText;
  try {
    const parsed = JSON.parse(responseText) as { errorMessages?: string[]; errors?: unknown; message?: string };
    const messages = [
      ...(parsed.errorMessages ?? []),
      ...(Array.isArray(parsed.errors) ? parsed.errors.map((error: { message?: string }) => error.message ?? "") : []),
      ...(parsed.errors && !Array.isArray(parsed.errors) && typeof parsed.errors === "object" ? Object.values(parsed.errors as Record<string, string>) : []),
      ...(parsed.message ? [parsed.message] : []),
    ].filter((message) => message !== "");
    if (messages.length > 0) detail = messages.join("; ");
  } catch {
    // not JSON: use the text as it is
  }
  detail = hideSecrets(detail.replace(/\s+/g, " ").trim(), secrets);
  if (detail === "") return "";
  return ` (${detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 3)}...` : detail})`;
}

export function describeHttpFailure(request: Pick<TrackerRequest, "trackerName" | "credentialsHint" | "secrets">, httpStatus: number, responseText: string): TrackerError {
  const detail = summarizeErrorBody(responseText, request.secrets);
  const { trackerName } = request;
  if (httpStatus === 401 || httpStatus === 403) {
    return new TrackerError(`${trackerName} rejected vika's credentials (HTTP ${httpStatus}). Check ${request.credentialsHint}.${detail}`, httpStatus);
  }
  if (httpStatus === 404) {
    return new TrackerError(`${trackerName} could not find what vika asked for (HTTP 404). Check the URL and the project or team in vika.yaml.${detail}`, httpStatus);
  }
  if (httpStatus === 429) {
    return new TrackerError(`${trackerName} is rate-limiting vika (HTTP 429). Nothing was retried; run again in a few minutes.${detail}`, httpStatus);
  }
  return new TrackerError(`${trackerName} answered with HTTP ${httpStatus}.${detail}`, httpStatus);
}

export async function sendTrackerRequest(request: TrackerRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await request.fetchFunction(request.url, {
      method: request.method,
      headers: { Accept: "application/json", ...(request.body === undefined ? {} : { "Content-Type": "application/json" }), ...request.headers },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    const errorName = (error as Error).name;
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      throw new TrackerError(`${request.trackerName} did not answer within ${request.timeoutMs / 1000} seconds. Nothing was retried.`, null);
    }
    throw new TrackerError(`could not reach ${request.trackerName} (${hideSecrets((error as Error).message, request.secrets)}). Check the network and the tracker URL.`, null);
  }

  const responseText = await response.text();
  if (!response.ok) throw describeHttpFailure(request, response.status, responseText);
  if (responseText === "") return {};
  try {
    return JSON.parse(responseText);
  } catch {
    throw new TrackerError(`${request.trackerName} sent an answer vika could not read (not JSON, HTTP ${response.status}).`, response.status);
  }
}
