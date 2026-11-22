// An in-memory stand-in for Anthropic's Messages API, so no test ever sends
// anything over the network. It records every request and answers with a
// fixed reply, an HTTP error, or never (to test the timeout).
import type { FetchFunction } from "../../src/ticket-trackers/tracker-types.js";

export const FAKE_ANSWER_TEXT = "Suspect 1 (PR #812) most likely: getUser now returns null, and createOrder reads user.email without a check.";

export interface RecordedAnthropicRequest {
  url: string;
  headers: Record<string, string>;
  body: { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] } & Record<string, unknown>;
}

export interface FakeAnthropicOptions {
  httpStatus?: number; // default 200
  errorMessage?: string; // the provider's own error text for a non-200 status
  answerText?: string; // default FAKE_ANSWER_TEXT
  isHanging?: boolean; // never answers; only the caller's timeout ends it
}

export interface FakeAnthropic {
  fetchFunction: FetchFunction;
  requests: RecordedAnthropicRequest[];
}

export function createFakeAnthropic(options: FakeAnthropicOptions = {}): FakeAnthropic {
  const requests: RecordedAnthropicRequest[] = [];
  const fetchFunction: FetchFunction = async (url, init) => {
    requests.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)) as RecordedAnthropicRequest["body"],
    });
    if (options.isHanging) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    const httpStatus = options.httpStatus ?? 200;
    if (httpStatus !== 200) {
      return new Response(JSON.stringify({ type: "error", error: { type: "error", message: options.errorMessage ?? "something went wrong" } }), {
        status: httpStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: options.answerText ?? FAKE_ANSWER_TEXT }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchFunction, requests };
}
