// Smoke test: proves we can reach the test Postgres database.
import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe("postgres smoke test", () => {
  it("connects and runs SELECT 1", async () => {
    if (!url) throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const result = await client.query<{ one: number }>("SELECT 1 AS one");
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await client.end();
    }
  });
});
