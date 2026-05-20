/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";

// -----------------------------------------------------------------------------
// initDb.ts — one-shot schema bootstrap. Reads init-db.sql and runs it against
// $DATABASE_URL. Idempotent: every statement uses IF NOT EXISTS / ADD CONSTRAINT
// guards so re-running is safe.
//
// We use a fresh pg.Client (not the app's shared pool) so we don't create
// long-lived state in this short-lived script.
//
// Usage:
//   npm run --prefix backend db:init
//   tsx backend/scripts/initDb.ts
// -----------------------------------------------------------------------------

function resolveDotEnv(): string {
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `FATAL: could not locate .env walking up from ${__dirname}`,
      );
    }
    dir = parent;
  }
}
dotenv.config({ path: resolveDotEnv() });

function resolveSql(): string {
  // Same dual-path trick as fetchTrades / config: tsx runs from
  // backend/scripts, compiled runs from dist/backend/scripts. Walk up until
  // we find init-db.sql under a scripts/ folder.
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, "init-db.sql");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `FATAL: could not locate init-db.sql walking up from ${__dirname}`,
      );
    }
    dir = parent;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "FATAL: DATABASE_URL is not set. Add it to .env (see .env.example).",
    );
  }

  const sqlPath = resolveSql();
  const sql = fs.readFileSync(sqlPath, "utf8");
  console.log(`[initDb] applying ${sqlPath}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    console.log("[initDb] OK — schema is up to date");
  } finally {
    await client.end();
  }

  // Seed the demo user row so existing data (positions/orders/...) for the
  // legacy hardcoded user id remains valid against the new FK.
  const { seedDemoUser } = await import("./seedDemoUser");
  await seedDemoUser();
}

main().catch((err) => {
  // Rule 1 + 4: never fail silently. Print full error and exit non-zero so
  // CI / pm2 see a clear failure.
  console.error("ERROR [initDb] schema bootstrap failed:", err);
  process.exit(1);
});
