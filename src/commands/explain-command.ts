



import { collectSecrets } from "../configuration/hide-secrets.js";
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import { addExplanationsToReport } from "../explanation/add-explanations-to-report.js";
import { askLlm } from "../explanation/ask-llm.js";
import { prepareExplanationRequests } from "../explanation/prepare-explanation-requests.js";
import { readSuspectDiffs } from "../explanation/read-suspect-diffs.js";
import { EXPLANATION_SYSTEM_PROMPT } from "../explanation/system-prompt.js";
import type { ServiceReportInput } from "../reporting/build-report.js";
import type { Report } from "../reporting/report-types.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";
import { approveAndExplain, NO_TERMINAL_MESSAGE, type ExplainConsole } from "./approve-and-explain.js";

export interface ExplainCommandOptions {
  configuration: LoadedConfiguration;
  report: Report;
  serviceInputs: ServiceReportInput[];
  fetchFunction: FetchFunction;
  explainConsole: ExplainConsole;
  readDiffs?: typeof readSuspectDiffs; 
}

export async function runExplainCommand(options: ExplainCommandOptions): Promise<Report> {
  const { configuration, explainConsole } = options;
  const apiKey = configuration.explain.apiKey;
  
  
  if (!configuration.explain.isEnabled || apiKey === null) return options.report;
  
  if (!explainConsole.isInteractive) {
    explainConsole.write(`\n${NO_TERMINAL_MESSAGE}\n`);
    return addExplanationsToReport(options.report, []);
  }
  const preparedExplanations = await prepareExplanationRequests({
    configuration,
    report: options.report,
    serviceInputs: options.serviceInputs,
    readDiffs: options.readDiffs ?? readSuspectDiffs,
  });
  if (preparedExplanations.length === 0) {
    explainConsole.write("\nAI explanations: no regressions to explain.\n");
    return addExplanationsToReport(options.report, []);
  }
  const secrets = collectSecrets(configuration);
  const explanations = await approveAndExplain(preparedExplanations, configuration.explain.model, explainConsole, (prepared) =>
    askLlm({
      model: configuration.explain.model,
      systemPrompt: EXPLANATION_SYSTEM_PROMPT,
      promptText: prepared.request.promptText,
      apiKey,
      fetchFunction: options.fetchFunction,
      secrets,
    }),
  );
  return addExplanationsToReport(options.report, explanations);
}
