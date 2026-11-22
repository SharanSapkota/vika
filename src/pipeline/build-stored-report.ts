import { collectSecrets, hideSecrets } from "../configuration/hide-secrets.js";
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import type { Store } from "../database/store-types.js";
import { buildReport, type ServiceReportInput } from "../reporting/build-report.js";
import type { Report } from "../reporting/report-types.js";
import { analyzeService } from "./analyze-service.js";
import { makeSkippedService } from "./run-all-services.js";

export async function buildStoredReport(store: Store, configuration: LoadedConfiguration): Promise<Report> {
  const secrets = collectSecrets(configuration);
  const serviceInputs: ServiceReportInput[] = [];
  for (const serviceName of Object.keys(configuration.services).sort()) {
    try {
      const deploys = await store.listDeploys(serviceName);
      serviceInputs.push(await analyzeService(store, serviceName, configuration.services[serviceName]!, deploys, []));
    } catch (error) {
      serviceInputs.push(makeSkippedService(serviceName, `failed: ${hideSecrets(error instanceof Error ? error.message : String(error), secrets)}`));
    }
  }
  return buildReport(serviceInputs);
}
