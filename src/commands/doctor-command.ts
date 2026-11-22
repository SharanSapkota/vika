


import { dirname } from "node:path";
import { collectSecrets, hideSecrets } from "../configuration/hide-secrets.js";
import type { LoadConfigurationOptions } from "../configuration/load-configuration.js";
import { inspectDatabase } from "../database/database-store.js";
import type { StoreOptions } from "../database/store-types.js";
import { checkConfiguration } from "../doctor/check-configuration.js";
import { checkDatabase } from "../doctor/check-database.js";
import { checkDeploys } from "../doctor/check-deploys.js";
import { checkExplanation } from "../doctor/check-explanation.js";
import { checkServiceLogs } from "../doctor/check-service-logs.js";
import { checkServiceRepository } from "../doctor/check-service-repository.js";
import { checkTracker } from "../doctor/check-tracker.js";
import { checkWebhook } from "../doctor/check-webhook.js";
import type { DoctorCheck } from "../doctor/doctor-check-types.js";
import { readFileAtCommit } from "../suspect-attribution/git-blame-reader.js";
import { createTracker } from "../ticket-trackers/create-tracker.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";

export interface DoctorCommandOptions extends LoadConfigurationOptions {
  fetchFunction: FetchFunction;
  storeOptions?: StoreOptions;
  commandTimeoutMs?: number;
}

export interface DoctorCommandResult {
  checks: DoctorCheck[];
  exitCode: number; 
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<DoctorCommandResult> {
  const configurationResult = checkConfiguration(options);
  const checks = [...configurationResult.checks];
  const configuration = configurationResult.configuration;
  if (configuration === null) return { checks, exitCode: 1 };
  const secrets = collectSecrets(configuration);
  const serviceNames = Object.keys(configuration.services).sort();

  const inspection = await inspectDatabase(configuration.databaseUrl, serviceNames, options.storeOptions);
  const databaseName = decodeURIComponent(new URL(configuration.databaseUrl).pathname.replace(/^\//, "")) || "(none)";
  checks.push(...checkDatabase(inspection, configuration.warnings, databaseName));

  for (const serviceName of serviceNames) {
    const serviceSettings = configuration.services[serviceName]!;
    const storedDeploys = inspection.status === "connected" ? (inspection.deploysByService[serviceName] ?? []) : null;
    const repositoryResult = await checkServiceRepository({
      serviceName,
      repoPath: serviceSettings.repo,
      branch: serviceSettings.branch,
      latestStoredDeploy: storedDeploys?.at(-1) ?? null,
    });
    checks.push(...repositoryResult.checks);
    checks.push(
      ...(await checkServiceLogs({
        serviceName,
        logs: serviceSettings.logs,
        configurationDirectory: dirname(configuration.configurationFilePath),
        pathMap: serviceSettings.pathMap,
        language: serviceSettings.language,
        logFormat: serviceSettings.logFormat,
        doesRepoFileExist: repositoryResult.isBranchReadable
          ? async (repoPath) => (await readFileAtCommit(serviceSettings.repo, serviceSettings.branch, repoPath)) !== undefined
          : undefined,
        ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
      })),
    );
    checks.push(...checkDeploys({ serviceName, source: serviceSettings.deploys.source, branch: serviceSettings.branch, storedDeployCount: storedDeploys?.length ?? null }));
  }

  checks.push(...(await checkTracker(createTracker(configuration, options.fetchFunction, secrets), secrets)));
  checks.push(...checkWebhook(configuration.webhook));
  checks.push(...checkExplanation(configuration.explain));

  
  const maskedChecks = checks.map((check) => ({
    ...check,
    message: hideSecrets(check.message, secrets),
    fix: check.fix === null ? null : hideSecrets(check.fix, secrets),
  }));
  return { checks: maskedChecks, exitCode: maskedChecks.some((check) => check.level === "FAIL") ? 1 : 0 };
}
