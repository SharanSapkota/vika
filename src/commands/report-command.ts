// `vika report` (and `vika run`, which shares it): for every service in
// vika.yaml, read new logs, bring the deploy timeline up to date, detect
// regressions, name suspects, and build one report. A dry run as far as the
// outside world goes: it writes only to vika's own Postgres, never to a
// ticket tracker. One service failing doesn't stop the others.
import { runWithSecretsHidden } from "../configuration/hide-secrets.js";
import { loadConfiguration, type LoadedConfiguration } from "../configuration/load-configuration.js";
import { openStore } from "../database/database-store.js";
import type { StoreOptions } from "../database/store-types.js";
import { runAllServices, type ServiceRunStatus } from "../pipeline/run-all-services.js";
import { buildReport } from "../reporting/build-report.js";
import type { Report } from "../reporting/report-types.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";
import { sendRegressionWebhooks } from "../webhook/send-regression-webhooks.js";

export interface ReportCommandOptions {
  workingDirectory: string;
  configurationPath?: string;
  environment?: Record<string, string | undefined>;
  storeOptions?: StoreOptions; // tests use their own Postgres schema
  // Set by `vika run` only: post new regressions to vika.yaml's webhook.
  webhookFetchFunction?: FetchFunction;
}

export interface ReportCommandResult {
  report: Report;
  configuration: LoadedConfiguration;
  serviceStatuses: ServiceRunStatus[]; // ok, busy or failed, per service
  // What this run did ("read 5812 new log lines"). Kept out of the report,
  // so the same stored data always gives the same report.
  runNotes: string[];
  webhookWarnings: string[]; // plain English; a webhook problem never fails the run
  webhookDeliveredCount: number;
}

export async function runReportCommand(options: ReportCommandOptions): Promise<ReportCommandResult> {
  const configuration = loadConfiguration({
    workingDirectory: options.workingDirectory,
    ...(options.configurationPath === undefined ? {} : { configurationPath: options.configurationPath }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });

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
      };
    } finally {
      await store.close();
    }
  });
}
