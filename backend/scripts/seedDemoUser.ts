/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';

// -----------------------------------------------------------------------------
// seedDemoUser.ts — idempotent insert of the demo user row.
//
// The pre-auth app keyed everything off cfg.currentUserId
// (3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab). Phase 1 introduces a real users
// table; this script makes that UUID a real row so existing positions/orders/
// alerts/watchlist/equity_snapshots foreign-key cleanly.
//
// google_sub='demo' is what middleware.ts uses to set isDemo=true on the
// AuthUser shape.
// -----------------------------------------------------------------------------

const DEMO_USER_ID = '3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab';

function resolveDotEnv(): string {
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`FATAL: could not locate .env walking up from ${__dirname}`);
    }
    dir = parent;
  }
}

export async function seedDemoUser(): Promise<void> {
  dotenv.config({ path: resolveDotEnv() });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('FATAL: DATABASE_URL is not set');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      `INSERT INTO paper_trade_pro.users
         (id, google_sub, email, email_lower, name, picture_url)
       VALUES
         ($1, 'demo', 'demo@papertrade.local', 'demo@papertrade.local',
          'Demo Account', NULL)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [DEMO_USER_ID],
    );
    if (result.rowCount === 1) {
      console.log(`[seedDemoUser] inserted demo user ${DEMO_USER_ID}`);
    } else {
      console.log(`[seedDemoUser] demo user ${DEMO_USER_ID} already present`);
    }
  } finally {
    await client.end();
  }
}

// Standalone invocation (`tsx backend/scripts/seedDemoUser.ts`).
if (require.main === module) {
  seedDemoUser().catch((err) => {
    console.error('ERROR [seedDemoUser] failed:', err);
    process.exit(1);
  });
}
