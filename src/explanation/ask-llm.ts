// THE only place that talks to the AI provider (Anthropic's Messages API).
//
// - fetch is passed in, so tests never touch the network.
// - One request, a 30 second timeout, and no automatic retries.
// - Every failure becomes one plain-English message. The API key is sent
//   only in the x-api-key header and is masked out of every message.
// - Never throws: it returns { answerText } or { message }.
import { hideSecrets } from "../configuration/hide-secrets.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2026-10-21";
export const LLM_TIMEOUT_MS = 30_000;
// The answer is meant to be under 120 words (about 200 tokens). Current
// models also think before answering, and that thinking counts against this
// limit, so there is room for both.
export const MAX_ANSWER_TOKENS = 1024;
// Little thinking is needed to pick one of three listed commits.
export const ANSWER_EFFORT = "low";

const MAX_DETAIL_LENGTH = 200;

export interface AskLlmRequest {
  model: string;
  systemPrompt: string;
  promptText: string;
  apiKey: string;
  fetchFunction: FetchFunction;
  secrets: string[]; // masked out of any message, with the API key
  timeoutMs?: number;
}

export type AskLlmResult = { status: "answered"; answerText: string } | { status: "failed"; message: string };

interface MessagesResponse {
  content?: { type?: string; text?: string }[];
  stop_reason?: string | null;
}

// The provider's own short error text, if it sent one, with secrets masked.
function readErrorDetail(responseText: string, secrets: string[]): string {
  let detail = "";
  try {
    detail = (JSON.parse(responseText) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    // not JSON: leave the detail out
  }
  detail = hideSecrets(detail.replace(/\s+/g, " ").trim(), secrets);
  if (detail === "") return "";
  return ` (${detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 3)}...` : detail})`;
}

function describeHttpFailure(httpStatus: number, model: string, detail: string): string {
  if (httpStatus === 401) return `The AI provider rejected the API key (HTTP 401). Check ANTHROPIC_API_KEY in .env.${detail}`;
  if (httpStatus === 404) return `The AI provider does not know the model "${model}" (HTTP 404). Check explain.model in vika.yaml.${detail}`;
  if (httpStatus === 429) return `The AI provider is rate-limiting this key (HTTP 429). Nothing was retried; try again in a few minutes.${detail}`;
  return `The AI provider answered with HTTP ${httpStatus}. Nothing was retried.${detail}`;
}

export async function askLlm(request: AskLlmRequest): Promise<AskLlmResult> {
  const secrets = [request.apiKey, ...request.secrets];
  const timeoutMs = request.timeoutMs ?? LLM_TIMEOUT_MS;
  const fail = (message: string): AskLlmResult => ({ status: "failed", message: hideSecrets(message, secrets) });

  let response: Response;
  try {
    response = await request.fetchFunction(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: MAX_ANSWER_TOKENS,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.promptText }],
        output_config: { effort: ANSWER_EFFORT },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const errorName = (error as Error).name;
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      return fail(`The AI provider did not answer within ${timeoutMs / 1000} seconds. Nothing was retried.`);
    }
    return fail(`Could not reach the AI provider (${(error as Error).message}). Check the network.`);
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    const errorName = (error as Error).name;
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      return fail(`The AI provider did not answer within ${timeoutMs / 1000} seconds. Nothing was retried.`);
    }
    return fail(`The AI provider's answer could not be read (${(error as Error).message}).`);
  }
  if (!response.ok) return fail(describeHttpFailure(response.status, request.model, readErrorDetail(responseText, secrets)));

  let parsed: MessagesResponse;
  try {
    parsed = JSON.parse(responseText) as MessagesResponse;
  } catch {
    return fail(`The AI provider sent an answer vika could not read (not JSON, HTTP ${response.status}).`);
  }
  if (parsed.stop_reason === "refusal") return fail("The AI declined to answer this request.");
  const answerText = (parsed.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n")
    .trim();
  if (answerText === "") {
    return fail(parsed.stop_reason === "max_tokens" ? "The AI ran out of room before it answered." : "The AI sent an empty answer.");
  }
  return { status: "answered", answerText: hideSecrets(parsed.stop_reason === "max_tokens" ? `${answerText} [answer cut off]` : answerText, secrets) };
}
