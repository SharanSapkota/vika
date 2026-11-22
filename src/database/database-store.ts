// The only file that talks to Postgres. All SQL lives here.
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { NORMALIZER_VERSION } from "../error-grouping/normalize-message.js";
import type { MinerState } from "../error-grouping/template-miner.js";
import type { Frame } from "../log-parsing/log-entry-types.js";
import type { Bookmark, Deploy, StoredCluster, StoredWebhookEvent, Store, StoreOptions } from "./store-types.js";

export type { Batch, Bookmark, Deploy, StoredCluster, Store, StoreOptions } from "./store-types.js";

// Advisory lock ids ("vika" and "vikb" as hex), so they don't clash with
// locks other apps on the same database may take.
const MIGRATION_LOCK_ID = 0x76696b61;
const RUN_LOCK_ID = 0x76696b62;

const MIGRATIONS_DIRECTORY = new URL("../../migrations/", import.meta.url);

const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((fileName) => /^\d+_[\w-]+\.sql$/.test(fileName))
    .sort();
}

// A client that threw is released as broken, so the pool doesn't reuse it.
async function withClient<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  try {
    return await work(client);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    client.release(failed);
  }
}

async function inTransaction<T>(client: pg.PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); // the original error matters more
    throw error;
  }
}

async function migrate(pool: pg.Pool, schema: string | undefined): Promise<void> {
  await withClient(pool, async (client) => {
    await client.query("SELECT pg_advisory_lock($1, 0)", [MIGRATION_LOCK_ID]);
    try {
      // The name was checked against SCHEMA_NAME_PATTERN, so it is safe to put in SQL.
      if (schema !== undefined) await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
      const appliedVersions = new Set(rows.map((row) => row.version));

      for (const fileName of migrationFiles()) {
        const version = fileName.replace(/\.sql$/, "");
        if (appliedVersions.has(version)) continue;
        const migrationSql = readFileSync(new URL(fileName, MIGRATIONS_DIRECTORY), "utf8");
        try {
          await inTransaction(client, async () => {
            await client.query(migrationSql);
            await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
          });
        } catch (error) {
          throw new Error(`migration ${fileName} failed: ${(error as Error).message}`, { cause: error });
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, 0)", [MIGRATION_LOCK_ID]);
    }
  });
}

// SQL for "the first 3 distinct values of existing followed by incoming",
// keeping their original order.
const firstThreeDistinctSql = (existing: string, incoming: string) => `(
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
    examples       = ${firstThreeDistinctSql("clusters.examples", "EXCLUDED.examples")},
    source_refs    = ${firstThreeDistinctSql("clusters.source_refs", "EXCLUDED.source_refs")},
    first_seen     = LEAST(clusters.first_seen, EXCLUDED.first_seen),
    last_seen      = GREATEST(clusters.last_seen, EXCLUDED.last_seen)`;

const ADD_COUNTS = `
  INSERT INTO cluster_counts (service, fingerprint, minute, count)
  SELECT $1, $2, minute, count FROM unnest($3::timestamptz[], $4::int[]) AS t(minute, count)
  ON CONFLICT (service, fingerprint, minute) DO UPDATE SET count = cluster_counts.count + EXCLUDED.count`;

const SAVE_MINER_STATE = `
  INSERT INTO miner_state (service, state) VALUES ($1, $2::jsonb)
  ON CONFLICT (service) DO UPDATE SET state = EXCLUDED.state`;

// first_read_at is written once: COALESCE keeps the value already stored.
const SAVE_BOOKMARK = `
  INSERT INTO bookmarks (service, source_key, byte_offset, inode, last_timestamp, first_read_at) VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (service, source_key) DO UPDATE SET
    byte_offset = EXCLUDED.byte_offset, inode = EXCLUDED.inode, last_timestamp = EXCLUDED.last_timestamp,
    first_read_at = COALESCE(bookmarks.first_read_at, EXCLUDED.first_read_at)`;

const CLUSTER_COLUMNS = "fingerprint, normalizer_version, template, exception_type, top_frames, examples, source_refs, first_seen, last_seen";

interface ClusterRow {
  fingerprint: string;
  normalizer_version: number;
  template: string;
  exception_type: string | null;
  top_frames: Frame[];
  examples: string[];
  source_refs: string[];
  first_seen: Date;
  last_seen: Date;
}

function toStoredCluster(service: string, row: ClusterRow): StoredCluster {
  const cluster: StoredCluster = {
    service,
    fingerprint: row.fingerprint,
    normalizerVersion: row.normalizer_version,
    template: row.template,
    topFrames: row.top_frames,
    examples: row.examples,
    sourceRefs: row.source_refs,
    firstSeen: row.first_seen.toISOString(),
    lastSeen: row.last_seen.toISOString(),
  };
  if (row.exception_type !== null) cluster.exceptionType = row.exception_type;
  return cluster;
}

const toIsoTimestamp = (date: Date) => date.toISOString();

export async function openStore(databaseUrl: string, options: StoreOptions = {}): Promise<Store> {
  const { schema } = options;
  if (schema !== undefined && !SCHEMA_NAME_PATTERN.test(schema)) throw new Error(`invalid schema name: ${schema}`);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(schema !== undefined ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on("error", () => {});

  try {
    await migrate(pool, schema);
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    async saveBatch({ service, clusters, minerState, bookmark }) {
      await withClient(pool, (client) =>
        inTransaction(client, async () => {
          for (const cluster of clusters) {
            if (cluster.service !== service) {
              throw new Error(`cluster ${cluster.fingerprint} is for service "${cluster.service}", not "${service}"`);
            }
            await client.query(UPSERT_CLUSTER, [
              service,
              cluster.fingerprint,
              NORMALIZER_VERSION,
              cluster.template,
              cluster.exceptionType ?? null,
              JSON.stringify(cluster.topFrames),
              JSON.stringify(cluster.examples.slice(0, 3)),
              JSON.stringify(cluster.sourceRefs.slice(0, 3)),
              cluster.firstSeen,
              cluster.lastSeen,
            ]);
            const minutes = Object.keys(cluster.countsPerMinute);
            if (minutes.length > 0) {
              await client.query(ADD_COUNTS, [service, cluster.fingerprint, minutes, minutes.map((minute) => cluster.countsPerMinute[minute])]);
            }
          }
          await client.query(SAVE_MINER_STATE, [service, JSON.stringify(minerState)]);
          await client.query(SAVE_BOOKMARK, [
            service,
            bookmark.sourceKey,
            bookmark.file?.offset ?? null,
            bookmark.file === undefined ? null : String(bookmark.file.inode),
            bookmark.lastTimestamp ?? null,
            bookmark.firstReadAt ?? null,
          ]);
        }),
      );
    },

    async getBookmark(service, sourceKey) {
      const { rows } = await pool.query<{
        byte_offset: string | null;
        inode: string | null;
        last_timestamp: Date | null;
        first_read_at: Date | null;
      }>("SELECT byte_offset, inode, last_timestamp, first_read_at FROM bookmarks WHERE service = $1 AND source_key = $2", [
        service,
        sourceKey,
      ]);
      const row = rows[0];
      if (!row) return undefined;
      const bookmark: Bookmark = { sourceKey };
      if (row.byte_offset !== null && row.inode !== null) bookmark.file = { offset: Number(row.byte_offset), inode: Number(row.inode) };
      if (row.last_timestamp !== null) bookmark.lastTimestamp = toIsoTimestamp(row.last_timestamp);
      if (row.first_read_at !== null) bookmark.firstReadAt = toIsoTimestamp(row.first_read_at);
      return bookmark;
    },

    async getMinerState(service) {
      const { rows } = await pool.query<{ state: MinerState }>("SELECT state FROM miner_state WHERE service = $1", [service]);
      return rows[0]?.state;
    },

    async getCluster(service, fingerprint) {
      const { rows } = await pool.query<ClusterRow>(`SELECT ${CLUSTER_COLUMNS} FROM clusters WHERE service = $1 AND fingerprint = $2`, [
        service,
        fingerprint,
      ]);
      const row = rows[0];
      return row ? toStoredCluster(service, row) : undefined;
    },

    async listClusters(service) {
      const { rows } = await pool.query<ClusterRow>(`SELECT ${CLUSTER_COLUMNS} FROM clusters WHERE service = $1 ORDER BY fingerprint`, [
        service,
      ]);
      return rows.map((row) => toStoredCluster(service, row));
    },

    async listClusterCounts(service) {
      const { rows } = await pool.query<{ fingerprint: string; minute: Date; count: number }>(
        "SELECT fingerprint, minute, count FROM cluster_counts WHERE service = $1 ORDER BY fingerprint, minute",
        [service],
      );
      const countsByFingerprint: Record<string, Record<string, number>> = {};
      for (const row of rows) (countsByFingerprint[row.fingerprint] ??= {})[toIsoTimestamp(row.minute)] = row.count;
      return countsByFingerprint;
    },

    async getLogHistory(service) {
      const { rows } = await pool.query<{ history_start: Date | null; last_log_timestamp: Date | null }>(
        "SELECT min(first_read_at) AS history_start, max(last_timestamp) AS last_log_timestamp FROM bookmarks WHERE service = $1",
        [service],
      );
      const row = rows[0];
      return {
        historyStart: row?.history_start ? toIsoTimestamp(row.history_start) : null,
        lastLogTimestamp: row?.last_log_timestamp ? toIsoTimestamp(row.last_log_timestamp) : null,
      };
    },

    // Per-minute counts in [fromTime, toTime), oldest first.
    async getClusterCounts(service, fingerprint, fromTime, toTime) {
      const { rows } = await pool.query<{ minute: Date; count: number }>(
        `SELECT minute, count FROM cluster_counts
         WHERE service = $1 AND fingerprint = $2 AND minute >= $3 AND minute < $4
         ORDER BY minute`,
        [service, fingerprint, fromTime, toTime],
      );
      return Object.fromEntries(rows.map((row) => [toIsoTimestamp(row.minute), row.count]));
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
      return rows.map((row) => row.fingerprint);
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
      return rows.map((row) => ({ service, sha: row.sha, previousSha: row.previous_sha, time: toIsoTimestamp(row.time), source: row.source }));
    },

    // The lock key includes the schema, so tests in separate schemas never block each other.
    async withRunLock(service, work) {
      return withClient(pool, async (client) => {
        const lockArguments = [RUN_LOCK_ID, service];
        const lockKeySql = "$1, hashtext(current_schema() || '/' || $2)";
        const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${lockKeySql}) AS locked`, lockArguments);
        if (!rows[0]?.locked) return "busy" as const;
        try {
          return await work();
        } finally {
          await client.query(`SELECT pg_advisory_unlock(${lockKeySql})`, lockArguments);
        }
      });
    },

    async findTicket(service, dedupKey) {
      const { rows } = await pool.query<{
        issue_key: string;
        issue_url: string;
        tracker_type: string;
        deploy_sha: string;
        fingerprints: string[];
        last_known_count: number;
        last_commented_count: number;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT issue_key, issue_url, tracker_type, deploy_sha, fingerprints, last_known_count, last_commented_count, created_at, updated_at
         FROM tickets WHERE service = $1 AND dedup_key = $2`,
        [service, dedupKey],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        service,
        dedupKey,
        issueKey: row.issue_key,
        issueUrl: row.issue_url,
        trackerType: row.tracker_type,
        deploySha: row.deploy_sha,
        fingerprints: row.fingerprints,
        lastKnownCount: row.last_known_count,
        lastCommentedCount: row.last_commented_count,
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
      };
    },

    async saveTicket(ticket) {
      // Filing the ticket counts as the first time vika wrote to it.
      const result = await pool.query(
        `INSERT INTO tickets (service, dedup_key, issue_key, issue_url, tracker_type, deploy_sha, fingerprints, last_known_count, last_commented_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
         ON CONFLICT (service, dedup_key) DO NOTHING`,
        [
          ticket.service,
          ticket.dedupKey,
          ticket.issueKey,
          ticket.issueUrl,
          ticket.trackerType,
          ticket.deploySha,
          JSON.stringify(ticket.fingerprints),
          ticket.lastKnownCount,
        ],
      );
      return result.rowCount === 1;
    },

    async updateTicketCount(service, dedupKey, count) {
      await pool.query("UPDATE tickets SET last_known_count = $3, updated_at = now() WHERE service = $1 AND dedup_key = $2", [
        service,
        dedupKey,
        count,
      ]);
    },

    async recordTicketComment(service, dedupKey, count) {
      await pool.query(
        "UPDATE tickets SET last_known_count = $3, last_commented_count = $3, updated_at = now() WHERE service = $1 AND dedup_key = $2",
        [service, dedupKey, count],
      );
    },

    async updateTicketFingerprints(service, dedupKey, fingerprints) {
      await pool.query("UPDATE tickets SET fingerprints = $3::jsonb, updated_at = now() WHERE service = $1 AND dedup_key = $2", [
        service,
        dedupKey,
        JSON.stringify(fingerprints),
      ]);
    },

    async findWebhookEvent(key) {
      const { rows } = await pool.query<{ event_id: string; status: StoredWebhookEvent["status"]; attempts: number }>(
        "SELECT event_id, status, attempts FROM webhook_events WHERE service = $1 AND deploy_sha = $2 AND fingerprint = $3",
        [key.service, key.deploySha, key.fingerprint],
      );
      const row = rows[0];
      return row === undefined ? undefined : { ...key, eventId: row.event_id, status: row.status, attempts: row.attempts };
    },

    async saveWebhookEvent(key, eventId) {
      const result = await pool.query(
        `INSERT INTO webhook_events (service, deploy_sha, fingerprint, event_id, status) VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (service, deploy_sha, fingerprint) DO NOTHING`,
        [key.service, key.deploySha, key.fingerprint, eventId],
      );
      return result.rowCount === 1;
    },

    async recordWebhookAttempt(key, status) {
      await pool.query(
        `UPDATE webhook_events SET status = $4, attempts = attempts + 1, updated_at = now()
         WHERE service = $1 AND deploy_sha = $2 AND fingerprint = $3`,
        [key.service, key.deploySha, key.fingerprint, status],
      );
    },

    async deleteServiceData(service) {
      // Counts before clusters, because deleting a cluster also deletes its counts.
      const tables = ["cluster_counts", "clusters", "bookmarks", "miner_state", "deploys", "tickets", "webhook_events"];
      return withClient(pool, (client) =>
        inTransaction(client, async () => {
          const deletedRows: Record<string, number> = {};
          // The table names are fixed above, never from input, so they are safe in SQL.
          for (const table of tables) deletedRows[table] = (await client.query(`DELETE FROM ${table} WHERE service = $1`, [service])).rowCount ?? 0;
          return deletedRows;
        }),
      );
    },

    async appliedMigrations() {
      const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
      return rows.map((row) => row.version);
    },

    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only inspection, for `vika doctor`
// ---------------------------------------------------------------------------

// What doctor learns from the database. Connecting never migrates and never
// writes: doctor only looks.
export type DatabaseInspection =
  | {
      status: "connected";
      appliedMigrations: string[];
      availableMigrations: string[]; // the migration files vika ships with
      deploysByService: Record<string, Deploy[]>; // oldest first
    }
  | { status: "unreachable" | "wrong-password" | "missing-database" | "failed"; detail: string };

const CONNECT_TIMEOUT_MS = 5_000;
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]);

// Postgres error codes: 28P01 / 28000 = login refused, 3D000 = no such
// database, 42P01 = no such table (vika's tables don't exist yet).
function classifyConnectionError(error: unknown): DatabaseInspection {
  const code = (error as { code?: string }).code ?? "";
  const detail = error instanceof Error ? error.message : String(error);
  if (code === "28P01" || code === "28000") return { status: "wrong-password", detail };
  if (code === "3D000") return { status: "missing-database", detail };
  if (UNREACHABLE_CODES.has(code) || /timeout|terminated unexpectedly/i.test(detail)) return { status: "unreachable", detail };
  return { status: "failed", detail };
}

async function queryOrEmpty<Row extends pg.QueryResultRow>(client: pg.Client, sql: string, values: unknown[]): Promise<Row[]> {
  try {
    return (await client.query<Row>(sql, values)).rows;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

export async function inspectDatabase(databaseUrl: string, serviceNames: string[], options: StoreOptions = {}): Promise<DatabaseInspection> {
  const { schema } = options;
  if (schema !== undefined && !SCHEMA_NAME_PATTERN.test(schema)) throw new Error(`invalid schema name: ${schema}`);
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...(schema !== undefined ? { options: `-c search_path=${schema}` } : {}),
  });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    return classifyConnectionError(error);
  }
  try {
    const migrationRows = await queryOrEmpty<{ version: string }>(client, "SELECT version FROM schema_migrations ORDER BY version", []);
    const deploysByService: Record<string, Deploy[]> = {};
    for (const service of serviceNames) {
      const deployRows = await queryOrEmpty<{ sha: string; previous_sha: string | null; time: Date; source: string }>(
        client,
        "SELECT sha, previous_sha, time, source FROM deploys WHERE service = $1 ORDER BY time, sha",
        [service],
      );
      deploysByService[service] = deployRows.map((row) => ({
        service,
        sha: row.sha,
        previousSha: row.previous_sha,
        time: toIsoTimestamp(row.time),
        source: row.source,
      }));
    }
    return {
      status: "connected",
      appliedMigrations: migrationRows.map((row) => row.version),
      availableMigrations: migrationFiles().map((fileName) => fileName.replace(/\.sql$/, "")),
      deploysByService,
    };
  } catch (error) {
    return classifyConnectionError(error);
  } finally {
    await client.end().catch(() => {});
  }
}
