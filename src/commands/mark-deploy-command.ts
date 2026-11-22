





import { loadConfiguration, type LoadedConfiguration } from "../configuration/load-configuration.js";
import { openStore } from "../database/database-store.js";
import type { Deploy, StoreOptions } from "../database/store-types.js";
import { buildMarkerDeploy } from "../deploys/marker-deploys.js";
import { runWithSecretsHidden } from "../configuration/hide-secrets.js";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface MarkDeployOptions {
  workingDirectory: string;
  configurationPath?: string;
  environment?: Record<string, string | undefined>;
  storeOptions?: StoreOptions;
  serviceName: string;
  sha: string;
  previousSha?: string;
  time?: string; 
  clock: () => Date;
}

export interface MarkDeployResult {
  deploy: Deploy;
  isNew: boolean; 
  configuration: LoadedConfiguration;
}


function readSha(value: string, optionName: string): string {
  const sha = value.trim().toLowerCase();
  if (!FULL_SHA.test(sha)) throw new Error(`${optionName} must be a full 40-character commit sha (got "${value}")`);
  return sha;
}

function readTime(value: string): string {
  const timestampMs = Date.parse(value);
  if (Number.isNaN(timestampMs)) throw new Error(`--time must be an ISO date and time, like 2026-03-06T14:00:00Z (got "${value}")`);
  return new Date(timestampMs).toISOString();
}

export async function runMarkDeployCommand(options: MarkDeployOptions): Promise<MarkDeployResult> {
  
  const sha = readSha(options.sha, "--sha");
  const previousSha = options.previousSha === undefined ? undefined : readSha(options.previousSha, "--previous-sha");
  const time = options.time === undefined ? options.clock().toISOString() : readTime(options.time);

  const configuration = loadConfiguration({
    workingDirectory: options.workingDirectory,
    ...(options.configurationPath === undefined ? {} : { configurationPath: options.configurationPath }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  const serviceNames = Object.keys(configuration.services);
  if (!serviceNames.includes(options.serviceName)) {
    throw new Error(`service "${options.serviceName}" is not in ${configuration.configurationFilePath} (services: ${serviceNames.join(", ")})`);
  }

  return runWithSecretsHidden(configuration, async () => {
    const store = await openStore(configuration.databaseUrl, options.storeOptions);
    try {
      
      
      const earlierDeploys = (await store.listDeploys(options.serviceName)).filter((deploy) => deploy.time < time && deploy.sha !== sha);
      const deploy = buildMarkerDeploy({
        service: options.serviceName,
        sha,
        time,
        ...(previousSha === undefined ? {} : { previousSha }),
        lastKnownSha: earlierDeploys.at(-1)?.sha ?? null,
      });
      return { deploy, isNew: await store.saveDeploy(deploy), configuration };
    } finally {
      await store.close();
    }
  });
}
