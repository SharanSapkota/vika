// `vika serve`: starts the local dashboard on 127.0.0.1 and keeps it running
// until stop() (Ctrl+C in the CLI). Opening the store may apply pending
// migrations to vika's own tables; nothing else is ever written except
// tickets someone files from the page.
import { collectSecrets, runWithSecretsHidden } from "../configuration/hide-secrets.js";
import { loadConfiguration, type LoadedConfiguration } from "../configuration/load-configuration.js";
import { openStore } from "../database/database-store.js";
import type { StoreOptions } from "../database/store-types.js";
import { startDashboardServer, type RunningDashboard } from "../dashboard/dashboard-server.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";

export interface ServeCommandOptions {
  workingDirectory: string;
  configurationPath?: string;
  environment?: Record<string, string | undefined>;
  storeOptions?: StoreOptions;
  fetchFunction: FetchFunction;
  port: number;
}

export interface RunningServe {
  dashboard: RunningDashboard;
  configuration: LoadedConfiguration;
  stop(): Promise<void>; // closes the server, then the database pool
}

export function parsePort(text: string): number {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port must be a whole number from 0 to 65535 (got "${text}")`);
  return port;
}

export async function runServeCommand(options: ServeCommandOptions): Promise<RunningServe> {
  const configuration = loadConfiguration({
    workingDirectory: options.workingDirectory,
    ...(options.configurationPath === undefined ? {} : { configurationPath: options.configurationPath }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  return runWithSecretsHidden(configuration, async () => {
    const store = await openStore(configuration.databaseUrl, options.storeOptions);
    try {
      const dashboard = await startDashboardServer({
        configuration,
        store,
        fetchFunction: options.fetchFunction,
        secrets: collectSecrets(configuration),
        port: options.port,
      });
      return {
        dashboard,
        configuration,
        stop: async () => {
          await dashboard.close();
          await store.close();
        },
      };
    } catch (error) {
      await store.close();
      // The most common reason, said plainly.
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`port ${options.port} is already in use; pick another with --port`);
      throw error;
    }
  });
}
