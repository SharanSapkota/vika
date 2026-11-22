// npm run demo:reset
//
// Undoes npm run demo:fixture: deletes every row vika stored for the demo
// service ("shopfront") in the database from the project's .env, then
// deletes ./demo-fixture. Rows of other services are not touched.
import { existsSync, rmSync } from "node:fs";
import { maskDatabaseUrl } from "../src/configuration/database-url-checks.js";
import { collectSecrets, hideSecrets } from "../src/configuration/hide-secrets.js";
import { openStore } from "../src/database/database-store.js";
import { DEMO_FOLDER, DEMO_SERVICE_NAME, readDatabaseUrl, readDemoEnvironment } from "./demo-fixture-settings.js";

async function resetDemoFixture(): Promise<void> {
  const databaseUrl = readDatabaseUrl(readDemoEnvironment());
  if (databaseUrl === undefined) {
    console.log("DATABASE_URL is not set (project .env), so no database rows were deleted.");
  } else {
    try {
      const store = await openStore(databaseUrl);
      try {
        const deletedRows = await store.deleteServiceData(DEMO_SERVICE_NAME);
        const totalCount = Object.values(deletedRows).reduce((total, count) => total + count, 0);
        const details = Object.entries(deletedRows)
          .filter(([, count]) => count > 0)
          .map(([table, count]) => `${table} ${count}`)
          .join(", ");
        console.log(`Deleted ${totalCount} rows for service "${DEMO_SERVICE_NAME}" in ${maskDatabaseUrl(databaseUrl)}${details === "" ? "" : ` (${details})`}.`);
      } finally {
        await store.close();
      }
    } catch (error) {
      // Only the URL itself is a secret here; mask it out of driver messages.
      const secrets = collectSecrets({ databaseUrl, trackerCredentials: { type: "none" }, webhook: null } as Parameters<typeof collectSecrets>[0]);
      throw new Error(`could not delete the demo rows: ${hideSecrets(error instanceof Error ? error.message : String(error), secrets)}`);
    }
  }

  if (existsSync(DEMO_FOLDER)) {
    rmSync(DEMO_FOLDER, { recursive: true, force: true });
    console.log("Deleted demo-fixture/.");
  } else {
    console.log("demo-fixture/ was already gone.");
  }
  console.log("To build it again: npm run demo:fixture");
}

resetDemoFixture().catch((error: unknown) => {
  console.error(`demo:reset: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
