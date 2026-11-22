// Runs every service in vika.yaml through the pipeline: read new logs,
// bring deploys up to date, detect regressions, name suspects. Shared by
// `vika report` and `vika run`.
//
// One service failing never stops the others: its error is caught, masked,
// recorded as status "failed", and shown in the report as a skipped service
// with the reason. A service whose lock is held by another run is "busy".
import { dirname } from "node:path";
import { collectSecrets, hideSecrets } from "../configuration/hide-secrets.js";
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import type { Store } from "../database/store-types.js";
import type { ServiceReportInput } from "../reporting/build-report.js";
import { analyzeService } from "./analyze-service.js";
import { ingestServiceLogs } from "./ingest-service-logs.js";
import { loadDeploysForService } from "./load-deploys-for-service.js";

export interface ServiceRunStatus {
  serviceName: string;
  status: "ok" | "busy" | "failed";
  message: string | null; // why, for busy and failed
}

export interface AllServicesResult {
  serviceInputs: ServiceReportInput[]; // one per service, in name order
  serviceStatuses: ServiceRunStatus[];
  // What this run did ("read 5812 new log lines"). Kept out of the report,
  // so the same stored data always gives the same report.
  runNotes: string[];
}

export function makeSkippedService(serviceName: string, note: string): ServiceReportInput {
  return {
    serviceName,
    isSkipped: true,
    notes: [note],
    clusters: [],
    countsByFingerprint: {},
    deploys: [],
    detection: { regressions: [], deploys: [] },
    attributions: [],
    lastLogTimestamp: null,
  };
}

async function runOneService(
  store: Store,
  configuration: LoadedConfiguration,
  serviceName: string,
  runNotes: string[],
): Promise<{ serviceInput: ServiceReportInput; status: ServiceRunStatus }> {
  const serviceSettings = configuration.services[serviceName]!;
  const notes: string[] = [];
  const ingestResult = await ingestServiceLogs({
    store,
    serviceName,
    logs: serviceSettings.logs,
    configurationDirectory: dirname(configuration.configurationFilePath),
    redactionKinds: configuration.redact,
  });
  if (ingestResult.status === "busy") {
    return { serviceInput: makeSkippedService(serviceName, ingestResult.message), status: { serviceName, status: "busy", message: ingestResult.message } };
  }
  if (ingestResult.status === "not-supported") {
    notes.push(ingestResult.message);
  } else {
    notes.push(...ingestResult.notes);
    runNotes.push(
      `${serviceName}: read ${ingestResult.linesRead} new log lines, kept ${ingestResult.entriesKept} error/warning entries` +
        (ingestResult.linesSkipped > 0 ? `, could not read ${ingestResult.linesSkipped}` : ""),
    );
  }

  const deployLoad = await loadDeploysForService(store, serviceName, serviceSettings);
  if (deployLoad.note !== null) notes.push(deployLoad.note);
  if (deployLoad.addedCount > 0) runNotes.push(`${serviceName}: saved ${deployLoad.addedCount} new deploys from git`);

  const serviceInput = await analyzeService(store, serviceName, serviceSettings, deployLoad.deploys, notes);
  return { serviceInput, status: { serviceName, status: "ok", message: null } };
}

export async function runAllServices(store: Store, configuration: LoadedConfiguration): Promise<AllServicesResult> {
  const secrets = collectSecrets(configuration);
  const result: AllServicesResult = { serviceInputs: [], serviceStatuses: [], runNotes: [] };
  // Sorted, so the report lists services in the same order every time.
  for (const serviceName of Object.keys(configuration.services).sort()) {
    try {
      const { serviceInput, status } = await runOneService(store, configuration, serviceName, result.runNotes);
      result.serviceInputs.push(serviceInput);
      result.serviceStatuses.push(status);
    } catch (error) {
      const message = hideSecrets(error instanceof Error ? error.message : String(error), secrets);
      result.serviceInputs.push(makeSkippedService(serviceName, `failed: ${message}`));
      result.serviceStatuses.push({ serviceName, status: "failed", message });
    }
  }
  return result;
}
