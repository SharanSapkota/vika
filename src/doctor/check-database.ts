// Doctor: does DATABASE_URL connect, and are vika's migrations applied?
// Pure: takes the inspection result (from inspectDatabase) and the
// configuration's URL warnings. Never shows the URL or its password.
import type { DatabaseInspection } from "../database/database-store.js";
import { failCheck, passCheck, warnCheck, type DoctorCheck } from "./doctor-check-types.js";

const AREA = "database";

export function checkDatabase(inspection: DatabaseInspection, urlWarnings: string[], databaseName: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  switch (inspection.status) {
    case "unreachable":
      checks.push(
        failCheck(AREA, "cannot reach the database host (nothing answered at the host and port in DATABASE_URL)", "start Postgres (docker compose up -d --wait db) or fix the host and port in DATABASE_URL"),
      );
      break;
    case "wrong-password":
      checks.push(failCheck(AREA, "the database refused the login (wrong user or password)", "check the user and password in DATABASE_URL (in .env)"));
      break;
    case "missing-database":
      checks.push(
        failCheck(AREA, `the server answered, but database "${databaseName}" does not exist`, `create it (createdb ${databaseName}) or fix the database name at the end of DATABASE_URL`),
      );
      break;
    case "failed":
      checks.push(failCheck(AREA, "could not use the database", "check DATABASE_URL and that the user may read and write the database"));
      break;
    case "connected": {
      checks.push(passCheck(AREA, "connected"));
      const pendingMigrations = inspection.availableMigrations.filter((migration) => !inspection.appliedMigrations.includes(migration));
      checks.push(
        pendingMigrations.length === 0
          ? passCheck(AREA, `all ${inspection.availableMigrations.length} migrations applied`)
          : warnCheck(AREA, `${pendingMigrations.length} migrations not applied yet: ${pendingMigrations.join(", ")}`, "nothing to do: they are applied automatically when `vika report` or `vika run` starts"),
      );
    }
  }
  for (const urlWarning of urlWarnings) checks.push(warnCheck(AREA, urlWarning, "change DATABASE_URL in .env as described"));
  return checks;
}
