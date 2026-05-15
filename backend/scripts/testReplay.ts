/* eslint-disable no-console */
import path from "node:path";
import { ReplayProvider } from "../src/providers/ReplayProvider";
import type { AppConfig } from "../src/config";
import { FREE_TIER } from "../../shared/src";

// -----------------------------------------------------------------------------
// Standalone smoke test for ReplayProvider. Does NOT require env / DB creds.
//
// Usage:
//   cd backend && npx tsx scripts/testReplay.ts
//   cd backend && npx tsx scripts/testReplay.ts 2026-05-01 TSLA 50     (date, symbol, max ticks)
//   cd backend && npx tsx scripts/testReplay.ts 2026-05-01 TSLA 20 0   (speed=0 = as-fast-as-possible)
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const [dateArg, symbolArg, limitArg, speedArg] = process.argv.slice(2);
  const date = dateArg ?? "2026-05-01";
  const symbol = (symbolArg ?? "TSLA").toUpperCase();
  const maxTicks = Number(limitArg ?? 20);
  const speed = Number(speedArg ?? 0); // 0 = drain ASAP for quick smoke

  const cfg = {
    replay: {
      date,
      speed,
      loop: false,
      cacheDir: path.resolve(__dirname, "..", ".replay-cache"),
    },
  } as unknown as AppConfig;
  // Only provider.cfg.replay and cfg.limits are read by ReplayProvider — we
  // cast through unknown to avoid having to fill in alpaca/db fields for a
  // standalone script.
  (cfg as unknown as { limits: typeof FREE_TIER }).limits = FREE_TIER;

  const provider = new ReplayProvider(cfg);

  console.log(`→ Replay smoke test: ${symbol} on ${date} (speed=${speed})`);
  console.log(`→ Cache dir:        ${cfg.replay.cacheDir}`);
  console.log(`→ Stopping after:   ${maxTicks} ticks`);
  console.log();

  let count = 0;
  const start = Date.now();

  const unsubscribe = await provider.startStream([symbol], {
    onQuote: (q) => {
      count += 1;
      if (count <= 5 || count % 50 === 0 || count === maxTicks) {
        console.log(
          `  [#${String(count).padStart(4)}] ${q.symbol} $${q.price.toFixed(3)} @ ${new Date(q.timestamp).toISOString()}`,
        );
      }
      if (count >= maxTicks) {
        void stop();
      }
    },
    onStatusChange: (s, detail) => {
      console.log(`  <status> ${s}${detail ? `: ${detail}` : ""}`);
      if (s === "disconnected" && detail === "replay ended") void stop();
    },
  });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log();
    console.log(`✔ Received ${count} ticks in ${elapsed}s`);
    await unsubscribe();
    process.exit(0);
  }

  // Safety timeout in case we stall.
  setTimeout(() => {
    console.error("✖ Timeout (30s) — stopping");
    void stop();
  }, 30_000);
}

main().catch((err) => {
  console.error("✖", err);
  process.exit(1);
});
