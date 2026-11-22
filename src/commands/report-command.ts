




import { runWithSecretsHidden } from "../configuration/hide-secrets.js";
import { loadConfiguration, type LoadedConfiguration } from "../configuration/load-configuration.js";
import { openStore } from "../database/database-store.js";
import { findExplainBlocker } from "../explanation/check-explain-allowed.js";
import type { StoreOptions } from "../database/store-types.js";
import { runAllServices, type ServiceRunStatus } from "../pipeline/run-all-services.js";
import { buildReport, type ServiceReportInput } from "../reporting/build-report.js";
import type { Report } from "../reporting/report-types.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";
import { sendRegressionWebhooks } from "../webhook/send-regression-webhooks.js";

export interface ReportCommandOptions {
  workingDirectory: string;
  configurationPath?: string;
  environment?: Record<string, string | undefined>;
  storeOptions?: StoreOptions; 
  
  webhookFetchFunction?: FetchFunction;
  
  
  isExplainRequested?: boolean;
}

export interface ReportCommandResult {
  report: Report;
  configuration: LoadedConfiguration;
  serviceStatuses: ServiceRunStatus[]; 
  
  
  runNotes: string[];
  webhookWarnings: string[]; 
  webhookDeliveredCount: number;
  
  serviceInputs: ServiceReportInput[];
}

export async function runReportCommand(options: ReportCommandOptions): Promise<ReportCommandResult> {
  const configuration = loadConfiguration({
    workingDirectory: options.workingDirectory,
    ...(options.configurationPath === undefined ? {} : { configurationPath: options.configurationPath }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });

  if (options.isExplainRequested) {
    const explainBlocker = findExplainBlocker(configuration.explain);
    if (explainBlocker !== null) throw new Error(explainBlocker);
  }

  return runWithSecretsHidden(configuration, async () => {
    const store = await openStore(configuration.databaseUrl, options.storeOptions);
    try {
      const allServices = await runAllServices(store, configuration);
      const report = buildReport(allServices.serviceInputs);
      const webhookResult =
        options.webhookFetchFunction !== undefined && configuration.webhook !== null
          ? await sendRegressionWebhooks({ store, webhook: configuration.webhook, report, fetchFunction: options.webhookFetchFunction })
          : { deliveredCount: 0, warnings: [] };
      return {
        report,
        configuration,
        serviceStatuses: allServices.serviceStatuses,
        runNotes: allServices.runNotes,
        webhookWarnings: webhookResult.warnings,
        webhookDeliveredCount: webhookResult.deliveredCount,
        serviceInputs: allServices.serviceInputs,
      };
    } finally {
      await store.close();
    }
  });
}
