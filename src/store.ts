import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { NORMALIZER_VERSION, type Cluster, type MinerState } from "./cluster.js";
import type { FileBookmark } from "./parse/source.js";
import type { Frame } from "./parse/types.js";

/
export interface Bookmark {
  sourceKey: string;
  file?: FileBookmark;
  lastTimestamp?: string; // ISO
}

export interface Batch {
  service: string;
  clusters: Cluster[];
  minerState: MinerState;
  bookmark: Bookmark;
}

export interface Deploy {
  service: string;
  sha: string;
  previousSha: string | null;
  time: string; // ISO
  source: string; // where we learned about it, e.g. "git", "file", "manual"
}

export interface StoredCluster {
  service: string;
  fingerprint: string;
  normalizerVersion: number;
  template: string;
  exceptionType?: string;
  topFrames: Frame[];
  examples: string[];
  sourceRefs: string[];
  firstSeen: string; // ISO
  lastSeen: string; // ISO
}

export interface StoreOptions {
  // Postgres schema to use instead of "public". Tests use a fresh one each.
  schema?: string;
}

export interface Store {
  saveBatch(batch: Batch): Promise<void>;
  getBookmark(service: string, sourceKey: string): Promise<Bookmark | undefined>;
  getMinerState(service: string): Promise<MinerState | undefined>;
  getCluster(service: string, fingerprint: string): Promise<StoredCluster | undefined>;
  getClusterCounts(service: string, fingerprint: string, fromTime: string, toTime: string): Promise<Record<string, number>>;
  getBaselineFingerprints(service: string, beforeTime: string, windowDays: number): Promise<string[]>;
  saveDeploy(deploy: Deploy): Promise<boolean>;
  listDeploys(service: string): Promise<Deploy[]>;
  withRunLock<T>(service: string, fn: () => Promise<T>): Promise<T | "busy">;
  appliedMigrations(): Promise<string[]>;
  close(): Promise<void>;
}
const MIGRATION_LOCK = 0x76696b61;
const RUN_LOCK = 0x76696b62;

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
    .sort();
}

async function withClient<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  try {
    return await fn(client);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    client.release(failed);
  }
}

async function inTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {}); // the original error matters more
    throw err;
  }
}

async function migrate(pool: pg.Pool, schema: string | undefined): Promise<void> {
  await withClient(pool, async (client) => {
    await client.query("SELECT pg_advisory_lock($1, 0)", [MIGRATION_LOCK]);
    try {
      // The name was checked against SCHEMA_NAME, so it is safe to put in SQL.
      if (schema !== undefined) await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
      const applied = new Set(rows.map((r) => r.version));

      for (const file of migrationFiles()) {
        const version = file.replace(/\.sql$/, "");
        if (applied.has(version)) continue;
        const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
        try {
          await inTransaction(client, async () => {
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
          });
        } catch (err) {
          throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, 0)", [MIGRATION_LOCK]);
    }
  });
}

const firstThree = (existing: string, incoming: string) => `(
  SELECT COALESCE(jsonb_agg(value ORDER BY pos), '[]'::jsonb)
  FROM (
    SELECT value, min(pos) AS pos
    FROM jsonb_array_elements(${existing} || ${incoming}) WITH ORDINALITY AS item(value, pos)
    GROUP BY value
    ORDER BY min(pos)
    LIMIT 3
  ) AS firsts
)`;

const UPSERT_CLUSTER = `
  INSERT INTO clusters (service, fingerprint, normalizer_version, template, exception_type,
                        top_frames, examples, source_refs, first_seen, last_seen)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
  ON CONFLICT (service, fingerprint) DO UPDATE SET
    template       = EXCLUDED.template,
    exception_type = COALESCE(clusters.exception_type, EXCLUDED.exception_type),
    examples       = ${firstThree("clusters.examples", "EXCLUDED.examples")},
    source_refs    = ${firstThree("clusters.source_refs", "EXCLUDED.source_refs")},
    first_seen     = LEAST(clusters.first_seen, EXCLUDED.first_seen),
    last_seen      = GREATEST(clusters.last_seen, EXCLUDED.last_seen)`;

const ADD_COUNTS = `
  INSERT INTO cluster_counts (service, fingerprint, minute, count)
  SELECT $1, $2, minute, count FROM unnest($3::timestamptz[], $4::int[]) AS t(minute, count)
  ON CONFLICT (service, fingerprint, minute) DO UPDATE SET count = cluster_counts.count + EXCLUDED.count`;

const SAVE_MINER_STATE = `
  INSERT INTO miner_state (service, state) VALUES ($1, $2::jsonb)
  ON CONFLICT (service) DO UPDATE SET state = EXCLUDED.state`;

const SAVE_BOOKMARK = `
  INSERT INTO bookmarks (service, source_key, byte_offset, inode, last_timestamp) VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (service, source_key) DO UPDATE SET
    byte_offset = EXCLUDED.byte_offset, inode = EXCLUDED.inode, last_timestamp = EXCLUDED.last_timestamp`;

const iso = (d: Date) => d.toISOString();


export async function openStore(databaseUrl: string, options: StoreOptions = {}): Promise<Store> {
  const { schema } = options;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name: ${schema}`);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(schema !== undefined ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on("error", () => {});

  try {
    await migrate(pool, schema);
  } catch (err) {
    await pool.end();
    throw err;
  }

  return {
    async saveBatch({ service, clusters, minerState, bookmark }) {
      await withClient(pool, (client) =>
        inTransaction(client, async () => {
          for (const c of clusters) {
            if (c.service !== service) throw new Error(`cluster ${c.fingerprint} is for service "${c.service}", not "${service}"`);
            await client.query(UPSERT_CLUSTER, [
              service,
              c.fingerprint,
              NORMALIZER_VERSION,
              c.template,
              c.exceptionType ?? null,
              JSON.stringify(c.topFrames),
              JSON.stringify(c.examples.slice(0, 3)),
              JSON.stringify(c.sourceRefs.slice(0, 3)),
              c.firstSeen,
              c.lastSeen,
            ]);
            const minutes = Object.keys(c.countsPerMinute);
            if (minutes.length > 0) {
              await client.query(ADD_COUNTS, [service, c.fingerprint, minutes, minutes.map((m) => c.countsPerMinute[m])]);
            }
          }
          await client.query(SAVE_MINER_STATE, [service, JSON.stringify(minerState)]);
          await client.query(SAVE_BOOKMARK, [
            service,
            bookmark.sourceKey,
            bookmark.file?.offset ?? null,
            bookmark.file === undefined ? null : String(bookmark.file.inode),
            bookmark.lastTimestamp ?? null,
          ]);
        }),
      );
    },

    async getBookmark(service, sourceKey) {
      const { rows } = await pool.query<{ byte_offset: string | null; inode: string | null; last_timestamp: Date | null }>(
        "SELECT byte_offset, inode, last_timestamp FROM bookmarks WHERE service = $1 AND source_key = $2",
        [service, sourceKey],
      );
      const row = rows[0];
      if (!row) return undefined;
      const bookmark: Bookmark = { sourceKey };
      if (row.byte_offset !== null && row.inode !== null) bookmark.file = { offset: Number(row.byte_offset), inode: Number(row.inode) };
      if (row.last_timestamp !== null) bookmark.lastTimestamp = iso(row.last_timestamp);
      return bookmark;
    },

    async getMinerState(service) {
      const { rows } = await pool.query<{ state: MinerState }>("SELECT state FROM miner_state WHERE service = $1", [service]);
      return rows[0]?.state;
    },

    async getCluster(service, fingerprint) {
      const { rows } = await pool.query<{
        normalizer_version: number;
        template: string;
        exception_type: string | null;
        top_frames: Frame[];
        examples: string[];
        source_refs: string[];
        first_seen: Date;
        last_seen: Date;
      }>(
        `SELECT normalizer_version, template, exception_type, top_frames, examples, source_refs, first_seen, last_seen
         FROM clusters WHERE service = $1 AND fingerprint = $2`,
        [service, fingerprint],
      );
      const row = rows[0];
      if (!row) return undefined;
      const cluster: StoredCluster = {
        service,
        fingerprint,
        normalizerVersion: row.normalizer_version,
        template: row.template,
        topFrames: row.top_frames,
        examples: row.examples,
        sourceRefs: row.source_refs,
        firstSeen: iso(row.first_seen),
        lastSeen: iso(row.last_seen),
      };
      if (row.exception_type !== null) cluster.exceptionType = row.exception_type;
      return cluster;
    },

    // Per-minute counts in [fromTime, toTime), oldest first.
    async getClusterCounts(service, fingerprint, fromTime, toTime) {
      const { rows } = await pool.query<{ minute: Date; count: number }>(
        `SELECT minute, count FROM cluster_counts
         WHERE service = $1 AND fingerprint = $2 AND minute >= $3 AND minute < $4
         ORDER BY minute`,
        [service, fingerprint, fromTime, toTime],
      );
      return Object.fromEntries(rows.map((r) => [iso(r.minute), r.count]));
    },

    async getBaselineFingerprints(service, beforeTime, windowDays) {
      const { rows } = await pool.query<{ fingerprint: string }>(
        `SELECT DISTINCT fingerprint FROM cluster_counts
         WHERE service = $1
           AND minute >= $2::timestamptz - $3::double precision * interval '1 day'
           AND minute + interval '1 minute' <= $2::timestamptz
         ORDER BY fingerprint`,
        [service, beforeTime, windowDays],
      );
      return rows.map((r) => r.fingerprint);
    },

    async saveDeploy(deploy) {
      const result = await pool.query(
        `INSERT INTO deploys (service, sha, previous_sha, time, source) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (service, sha, time) DO NOTHING`,
        [deploy.service, deploy.sha, deploy.previousSha, deploy.time, deploy.source],
      );
      return result.rowCount === 1;
    },

    async listDeploys(service) {
      const { rows } = await pool.query<{ sha: string; previous_sha: string | null; time: Date; source: string }>(
        "SELECT sha, previous_sha, time, source FROM deploys WHERE service = $1 ORDER BY time, sha",
        [service],
      );
      return rows.map((r) => ({ service, sha: r.sha, previousSha: r.previous_sha, time: iso(r.time), source: r.source }));
    },

    async withRunLock(service, fn) {
      return withClient(pool, async (client) => {
        const key = [RUN_LOCK, service];
        const keySql = "$1, hashtext(current_schema() || '/' || $2)";
        const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${keySql}) AS locked`, key);
        if (!rows[0]?.locked) return "busy" as const;
        try {
          return await fn();
        } finally {
          await client.query(`SELECT pg_advisory_unlock(${keySql})`, key);
        }
      });
    },

    async appliedMigrations() {
      const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
      return rows.map((r) => r.version);
    },

    async close() {
      await pool.end();
    },
  };
}
