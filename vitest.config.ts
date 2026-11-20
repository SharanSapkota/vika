import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Load .env (if present) so tests can read DATABASE_URL / TEST_DATABASE_URL.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
