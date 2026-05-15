import { Pool, type PoolConfig, types } from "pg";
import { log } from "@chongbei/web-basics/server";
import { loadConfig } from "./config";

// -----------------------------------------------------------------------------
// Single shared pg Pool for the process. Neon's pooler handles connection
// fan-out on their side, so we keep a small local pool and let it hold
// connections open until idle.
//
// We override the default parsers for NUMERIC and BIGINT so our code sees
// `number` instead of strings. NUMERIC up to ~15 significant digits fits
// safely in a JS number; anything larger would need a BigInt / decimal
// library, which the paper trading sim doesn't need.
//
// Timestamps stay as Date objects (pg's default); route handlers convert
// to epoch-ms before sending to the frontend.
// -----------------------------------------------------------------------------

// OID 1700 = numeric / decimal
types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));
// OID 20 = int8 / bigint
types.setTypeParser(20, (v) => (v == null ? null : Number(v)));

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  const cfg = loadConfig();
  const poolConfig: PoolConfig = {
    connectionString: cfg.databaseUrl,
    // Neon's pooler caps us well below this; the local pool just prevents
    // us from opening a fresh connection on every request.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };

  pool = new Pool(poolConfig);

  pool.on("error", (err) => {
    // Pool-level errors are rare but fatal for the bad client — we log and
    // let pg replace the connection on next checkout. Satisfies
    // CLAUDE.md rule 9 (database connection failures must be logged).
    log.error(
      { err, operation: "pg.pool.idle-client" },
      "EXCEPTION pg pool idle client error",
    );
  });

  return pool;
}

/** Run `fn` inside a transaction. Commits on success, rolls back on throw. */
export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr: unknown) {
      // Log the rollback failure but re-throw the original error — it has
      // the useful stack for the caller. Rule 9: rollback reasons logged.
      log.error(
        { err: rollbackErr, originalErr: err, operation: "pg.rollback" },
        "ERROR pg ROLLBACK failed after transaction error",
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Graceful shutdown — call from signal handlers. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
