// A person approves every AI request before it is sent. For each regression
// this shows the exact text (system instructions and message), then asks:
//   Send this to the AI? [y]es / [n]o
// Only "y" sends; anything else skips. Without an interactive terminal
// nothing is ever sent. Input and output are passed in, so tests can answer.
import type { AskLlmResult } from "../explanation/ask-llm.js";
import type { RegressionExplanation } from "../explanation/add-explanations-to-report.js";
import type { PreparedExplanation } from "../explanation/prepare-explanation-requests.js";
import { EXPLANATION_SYSTEM_PROMPT } from "../explanation/system-prompt.js";

export const EXPLAIN_QUESTION = "Send this to the AI? [y]es / [n]o ";
export const NO_TERMINAL_MESSAGE = "AI explanations: nothing was sent, because no terminal is available to approve each request. Run vika report --explain in a terminal.";

export interface ExplainConsole {
  isInteractive: boolean; // a person at a terminal who can answer
  write: (text: string) => void;
  ask: (question: string) => Promise<string>;
}

function describeRequest(prepared: PreparedExplanation, requestNumber: number, requestCount: number, model: string): string {
  return [
    "",
    `AI explanation request ${requestNumber} of ${requestCount} (${prepared.serviceName}, regression ${prepared.regressionIndex + 1})`,
    `This exact text would be sent to ${model}:`,
    "----- system instructions -----",
    EXPLANATION_SYSTEM_PROMPT,
    "----- message -----",
    prepared.request.promptText.replace(/\n+$/, ""),
    "----- end -----",
    ...prepared.request.leftOutNotes.map((note) => `Note: ${note}. It is never sent.`),
    "",
  ].join("\n");
}

export async function approveAndExplain(
  preparedExplanations: PreparedExplanation[],
  model: string,
  explainConsole: ExplainConsole,
  sendRequest: (prepared: PreparedExplanation) => Promise<AskLlmResult>,
): Promise<RegressionExplanation[]> {
  const results: RegressionExplanation[] = [];
  for (const [requestIndex, prepared] of preparedExplanations.entries()) {
    explainConsole.write(describeRequest(prepared, requestIndex + 1, preparedExplanations.length, model));
    const answer = (await explainConsole.ask(EXPLAIN_QUESTION)).trim().toLowerCase();
    if (answer !== "y") {
      explainConsole.write("Not sent.\n");
      results.push({ serviceName: prepared.serviceName, regressionIndex: prepared.regressionIndex, explanation: null });
      continue;
    }
    const llmResult = await sendRequest(prepared);
    if (llmResult.status === "failed") {
      explainConsole.write(`AI explanation failed: ${llmResult.message}\n`);
      results.push({ serviceName: prepared.serviceName, regressionIndex: prepared.regressionIndex, explanation: null });
      continue;
    }
    explainConsole.write("Answer received.\n");
    results.push({ serviceName: prepared.serviceName, regressionIndex: prepared.regressionIndex, explanation: { model, answerText: llmResult.answerText } });
  }
  return results;
}
