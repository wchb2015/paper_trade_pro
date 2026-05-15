/* eslint-disable no-console */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// -----------------------------------------------------------------------------
// fetchTrades.ts
//
// Downloads historical trades from Alpaca's REST endpoint and writes them to
// a local NDJSON file so we can later replay them through our own WebSocket.
//
// Docs: https://docs.alpaca.markets/reference/stocktrades-1
//
// Usage:
//   npx tsx backend/scripts/fetchTrades.ts TSLA 2026-05-01 09:30 10:30
//   npx tsx backend/scripts/fetchTrades.ts TSLA 2026-05-01 09:30 10:30 --feed iex
//
// Arguments:
//   symbol   Stock ticker (e.g. TSLA)
//   date     YYYY-MM-DD in America/New_York (e.g. 2026-05-01)
//   startHm  HH:MM in America/New_York (e.g. 09:30)
//   endHm    HH:MM in America/New_York (e.g. 10:30)
//
// Flags:
//   --feed iex|sip   (default: env ALPACA_FEED or 'iex')
//   --out  <path>    override default output directory
//   --force          overwrite an existing file
//
// Output:
//   backend/.replay-cache/<date>/<symbol>.ndjson   one trade per line
//   backend/.replay-cache/<date>/<symbol>.meta.json
// -----------------------------------------------------------------------------

// ---- tiny arg parser --------------------------------------------------------

interface Args {
  symbol: string;
  date: string; // YYYY-MM-DD
  startHm: string; // HH:MM
  endHm: string; // HH:MM
  feed: "iex" | "sip";
  out?: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`Flag --${key} needs a value`);
      }
      flags.set(key, val);
      i++;
      continue;
    }
    positional.push(a);
  }

  if (positional.length < 4) {
    throw new Error(
      "Usage: fetchTrades.ts <SYMBOL> <YYYY-MM-DD> <HH:MM> <HH:MM> [--feed iex|sip] [--out path] [--force]",
    );
  }

  const [symbol, date, startHm, endHm] = positional as [
    string,
    string,
    string,
    string,
  ];

  if (!/^[A-Za-z.]{1,8}$/.test(symbol))
    throw new Error(`Bad symbol: ${symbol}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Bad date: ${date}`);
  if (!/^\d{2}:\d{2}$/.test(startHm)) throw new Error(`Bad start: ${startHm}`);
  if (!/^\d{2}:\d{2}$/.test(endHm)) throw new Error(`Bad end: ${endHm}`);

  const feedRaw = (
    flags.get("feed") ??
    process.env.ALPACA_FEED ??
    "iex"
  ).toLowerCase();
  if (feedRaw !== "iex" && feedRaw !== "sip") {
    throw new Error(`Bad --feed: ${feedRaw} (must be iex or sip)`);
  }

  const args: Args = {
    symbol: symbol.toUpperCase(),
    date,
    startHm,
    endHm,
    feed: feedRaw,
    force,
  };
  const outFlag = flags.get("out");
  if (outFlag !== undefined) args.out = outFlag;
  return args;
}

// ---- timezone: America/New_York → UTC ISO -----------------------------------

/**
 * Convert a wall-clock time in America/New_York to a UTC ISO string.
 *
 * We cannot rely on `new Date('2026-05-01T09:30:00-04:00')` with a fixed offset
 * because the offset changes (EST = -05:00, EDT = -04:00) and we don't want to
 * hardcode it per-date. We use Intl.DateTimeFormat to discover what the ET
 * wall-clock would be for a probe UTC instant, then binary-search / correct
 * for the mismatch.
 *
 * Simpler, robust approach: take the target ET wall-clock, build a candidate
 * UTC by assuming a guess offset, then ask Intl what that UTC instant looks
 * like in ET. If it matches, done. Otherwise adjust by the delta.
 */
function etWallClockToUtcIso(date: string, hm: string): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = hm.split(":").map(Number) as [number, number];

  // First guess: assume UTC-4 (EDT). Build candidate UTC.
  let utcMs = Date.UTC(y, mo - 1, d, h + 4, mi, 0, 0);

  // Ask Intl what ET thinks of this instant, compare to desired, correct.
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(utcMs));

    const got: Record<string, string> = {};
    for (const p of parts) got[p.type] = p.value;

    const actualY = Number(got.year);
    const actualMo = Number(got.month);
    const actualD = Number(got.day);
    const actualH = Number(got.hour) === 24 ? 0 : Number(got.hour);
    const actualMi = Number(got.minute);

    if (
      actualY === y &&
      actualMo === mo &&
      actualD === d &&
      actualH === h &&
      actualMi === mi
    ) {
      return new Date(utcMs).toISOString();
    }

    // Compute drift (as wall-clock ms) and shift utcMs the other way.
    const actualMs = Date.UTC(
      actualY,
      actualMo - 1,
      actualD,
      actualH,
      actualMi,
      0,
      0,
    );
    const desiredMs = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
    const drift = actualMs - desiredMs;
    utcMs -= drift;
  }

  throw new Error(`Failed to resolve ET time ${date} ${hm} to UTC`);
}

// ---- env checks -------------------------------------------------------------

function readEnvCreds(): { keyId: string; secretKey: string; baseUrl: string } {
  const keyId = process.env.APCA_KEY_ID;
  const secretKey = process.env.APCA_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error(
      "Missing APCA_KEY_ID / APCA_SECRET_KEY. Copy .env.example → backend/.env and set your Alpaca keys.",
    );
  }
  const baseUrl = process.env.ALPACA_DATA_URL ?? "https://data.alpaca.markets";
  return { keyId, secretKey, baseUrl };
}

// ---- main download loop -----------------------------------------------------

interface AlpacaTrade {
  t: string; // RFC-3339 nanosecond UTC
  x: string; // exchange code
  p: number; // price
  s: number; // size (shares)
  c?: string[]; // condition codes
  i: number; // trade id
  z?: string; // tape
}

interface TradesResponse {
  trades: Record<string, AlpacaTrade[] | undefined>;
  next_page_token: string | null;
}

interface Meta {
  symbol: string;
  date: string;
  startIso: string;
  endIso: string;
  feed: "iex" | "sip";
  count: number;
  pages: number;
  downloadedAt: string;
  firstTradeIso: string | null;
  lastTradeIso: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { symbol, date, startHm, endHm, feed, force } = args;

  const { keyId, secretKey, baseUrl } = readEnvCreds();

  const startIso = etWallClockToUtcIso(date, startHm);
  const endIso = etWallClockToUtcIso(date, endHm);

  const outDir = args.out ?? path.join(__dirname, "..", ".replay-cache", date);
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `${symbol}.ndjson`);
  const metaFile = path.join(outDir, `${symbol}.meta.json`);

  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0 && !force) {
    console.error(
      `✖ ${outFile} already exists (size=${fs.statSync(outFile).size}). Pass --force to overwrite.`,
    );
    process.exit(1);
  }

  console.log(`→ Symbol:    ${symbol}`);
  console.log(`→ Date (ET): ${date}`);
  console.log(`→ Window:    ${startHm}–${endHm} ET`);
  console.log(`→ Window UTC: ${startIso} → ${endIso}`);
  console.log(`→ Feed:      ${feed}`);
  console.log(`→ Output:    ${outFile}`);
  console.log();

  const writeStream = fs.createWriteStream(outFile, { flags: "w" });

  const headers: Record<string, string> = {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secretKey,
    Accept: "application/json",
  };

  let pageToken: string | null = null;
  let page = 0;
  let total = 0;
  let firstTradeIso: string | null = null;
  let lastTradeIso: string | null = null;

  const tStart = Date.now();

  while (true) {
    const url = new URL("/v2/stocks/trades", baseUrl);
    url.searchParams.set("symbols", symbol);
    url.searchParams.set("start", startIso);
    url.searchParams.set("end", endIso);
    url.searchParams.set("limit", "10000");
    url.searchParams.set("feed", feed);
    url.searchParams.set("sort", "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetchWithRetry(url, headers);
    const json = (await res.json()) as TradesResponse;

    const trades = json.trades?.[symbol] ?? [];
    page += 1;

    for (const tr of trades) {
      writeStream.write(JSON.stringify(tr) + "\n");
      if (firstTradeIso === null) firstTradeIso = tr.t;
      lastTradeIso = tr.t;
    }
    total += trades.length;

    console.log(
      `  page ${String(page).padStart(3)} | +${String(trades.length).padStart(5)} trades | total=${total.toLocaleString()} | last=${lastTradeIso ?? "-"}`,
    );

    pageToken = json.next_page_token;
    if (!pageToken) break;

    // Gentle pacing — Alpaca free tier is 200 req/min.
    await sleep(250);
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  const meta: Meta = {
    symbol,
    date,
    startIso,
    endIso,
    feed,
    count: total,
    pages: page,
    downloadedAt: new Date().toISOString(),
    firstTradeIso,
    lastTradeIso,
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);

  console.log();
  console.log(`✔ Done in ${elapsed}s`);
  console.log(`  Trades:  ${total.toLocaleString()}`);
  console.log(`  Pages:   ${page}`);
  console.log(`  Size:    ${sizeMb} MB`);
  console.log(`  File:    ${outFile}`);
  console.log(`  Meta:    ${metaFile}`);
}

async function fetchWithRetry(
  url: URL,
  headers: Record<string, string>,
  maxAttempts = 5,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res;
      // Retry 429 + 5xx.
      if (res.status === 429 || res.status >= 500) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      // 4xx other than 429 — non-retryable.
      const body = await res.text().catch(() => "");
      throw new Error(
        `Non-retryable HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1));
      console.warn(
        `  ! attempt ${attempt}/${maxAttempts} failed (${(err as Error).message}). Retrying in ${backoff}ms...`,
      );
      await sleep(backoff);
    }
  }
  throw new Error(
    `fetch failed after ${maxAttempts} attempts: ${String(lastErr)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("✖", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
