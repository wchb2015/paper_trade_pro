/* eslint-disable no-console */
// -----------------------------------------------------------------------------
// dataProviderDemo.ts
//
// Single-file learning utility for this project's two market-data sources.
//
//   Live:    open Alpaca's market-data WebSocket, authenticate with
//            APCA_KEY_ID / APCA_SECRET_KEY, subscribe to trades, print ticks.
//   Replay:  stream NDJSON from backend/.replay-cache/<date>/<SYM>.ndjson,
//            merge multiple symbols in chronological order at a chosen speed.
//
// Both paths print one line per trade to stdout in the same pretty format,
// and emit `# ...` status lines on stderr (so stdout stays grep/jq-clean).
//
// Usage:
//   tsx backend/scripts/dataProviderDemo.ts --live    TSLA AAPL NVDA
//   tsx backend/scripts/dataProviderDemo.ts --replay  2026-05-15 TSLA AAPL
//   tsx backend/scripts/dataProviderDemo.ts --replay  2026-05-15 TSLA --speed 10
//   tsx backend/scripts/dataProviderDemo.ts --replay  2026-05-15 TSLA --speed 0    # ASAP
//
// This file deliberately re-implements the WS handshake and the NDJSON merge
// instead of importing from src/providers/*. The point is to read it
// top-to-bottom and see the whole picture.
// -----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import dotenv from "dotenv";
import WebSocket from "ws";

// -----------------------------------------------------------------------------
// .env resolver — walks up from this file to the repo-root .env. Mirrors the
// pattern in fetchTrades.ts so we work both via tsx (depth 2) and compiled
// node (depth 4).
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
dotenv.config({ path: resolveDotEnv(), quiet: true });

// -----------------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------------
type Mode = "live" | "replay";
type Feed = "iex" | "sip";

interface Args {
  mode: Mode;
  symbols: string[];
  date?: string; // replay only, YYYY-MM-DD
  feed: Feed; // live only
  speed: number; // replay only; 0 means ASAP
}

function printUsageAndExit(message?: string): never {
  if (message) console.error(`# ERROR ${message}`);
  console.error(
    [
      "Usage:",
      "  dataProviderDemo --live    <SYMBOL...> [--feed iex|sip]",
      "  dataProviderDemo --replay  <YYYY-MM-DD> <SYMBOL...> [--speed N]",
      "",
      "  --speed 1   real-time (default)",
      "  --speed 10  10x real-time",
      "  --speed 0   as fast as possible",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  if (args.length === 0) printUsageAndExit("missing arguments");

  let mode: Mode | null = null;
  let date: string | undefined;
  let feed: Feed = (process.env.ALPACA_FEED as Feed) ?? "iex";
  let speed = 1;
  const symbols: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--live") {
      if (mode) printUsageAndExit("specify only one of --live / --replay");
      mode = "live";
    } else if (tok === "--replay") {
      if (mode) printUsageAndExit("specify only one of --live / --replay");
      mode = "replay";
      const next = args[i + 1];
      if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next)) {
        printUsageAndExit("--replay requires a YYYY-MM-DD date");
      }
      date = next;
      i++;
    } else if (tok === "--feed") {
      const next = args[i + 1];
      if (next !== "iex" && next !== "sip") {
        printUsageAndExit("--feed must be 'iex' or 'sip'");
      }
      feed = next;
      i++;
    } else if (tok === "--speed") {
      const next = args[i + 1];
      const n = Number(next);
      if (!Number.isFinite(n) || n < 0) {
        printUsageAndExit("--speed must be a non-negative number");
      }
      speed = n;
      i++;
    } else if (tok && tok.startsWith("--")) {
      printUsageAndExit(`unknown flag: ${tok}`);
    } else if (tok) {
      symbols.push(tok.toUpperCase());
    }
  }

  if (!mode) printUsageAndExit("must pass --live or --replay <date>");
  if (symbols.length === 0) printUsageAndExit("must pass at least one symbol");
  if (mode === "replay" && !date) printUsageAndExit("missing replay date");

  const out: Args = { mode, symbols, feed, speed };
  if (date !== undefined) out.date = date;
  return out;
}

// -----------------------------------------------------------------------------
// Pretty printer — one line per trade. Stdout only; status goes to stderr.
// -----------------------------------------------------------------------------
function fmtTradeLine(
  isoTs: string,
  symbol: string,
  price: number,
  size: number,
  tag: string,
): string {
  // Truncate ns precision (e.g. 2026-05-15T13:30:00.093457262Z → ...093Z).
  const tsMs = isoTs.length > 24 ? `${isoTs.slice(0, 23)}Z` : isoTs;
  const sym = symbol.padEnd(6, " ");
  const px = `$${price.toFixed(3)}`.padStart(10, " ");
  const sz = `size=${String(size).padStart(7, " ")}`;
  return `${tsMs}  ${sym}  ${px}  ${sz}  [${tag}]`;
}

function status(line: string): void {
  console.error(`# ${line}`);
}

// -----------------------------------------------------------------------------
// LIVE PATH
// -----------------------------------------------------------------------------

interface AlpacaTradeFrame {
  T: "t";
  S: string;
  p: number;
  s: number;
  t: string;
}

interface AlpacaCtrlFrame {
  T: "success" | "error" | "subscription";
  msg?: string;
  code?: number;
}

type AlpacaFrame = AlpacaTradeFrame | AlpacaCtrlFrame;

async function runLive(symbols: string[], feed: Feed): Promise<void> {
  const keyId = process.env.APCA_KEY_ID;
  const secretKey = process.env.APCA_SECRET_KEY;
  if (!keyId || !secretKey) {
    console.error(
      "# ERROR missing APCA_KEY_ID / APCA_SECRET_KEY — set them in .env",
    );
    process.exit(1);
  }

  const url =
    process.env.ALPACA_STREAM_URL ?? `wss://stream.data.alpaca.markets/v2/${feed}`;
  const tag = feed;

  status(`connecting ${url}`);
  const ws = new WebSocket(url);

  let authed = false;
  let exitCode = 0;

  ws.on("open", () => {
    status("socket open — authenticating");
    ws.send(JSON.stringify({ action: "auth", key: keyId, secret: secretKey }));
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    let frames: AlpacaFrame[];
    try {
      const parsed = JSON.parse(raw.toString());
      frames = Array.isArray(parsed) ? (parsed as AlpacaFrame[]) : [parsed];
    } catch (err) {
      console.error(
        `# ERROR EXCEPTION failed to parse WS frame: ${(err as Error).message}`,
      );
      return;
    }

    for (const f of frames) {
      if (f.T === "success" && f.msg === "authenticated") {
        authed = true;
        status("auth ok");
        status(`subscribing trades=${symbols.join(",")}`);
        ws.send(JSON.stringify({ action: "subscribe", trades: symbols }));
      } else if (f.T === "success" && f.msg === "connected") {
        status("server hello");
      } else if (f.T === "subscription") {
        status(`subscribed ok`);
      } else if (f.T === "error") {
        console.error(
          `# ERROR alpaca: code=${f.code ?? "?"} msg=${f.msg ?? "?"}`,
        );
        exitCode = 1;
        ws.close();
      } else if (f.T === "t") {
        const trade = f;
        console.log(fmtTradeLine(trade.t, trade.S, trade.p, trade.s, tag));
      }
      // Other frame types (q, b, …) ignored on purpose — this demo is trades-only.
    }
  });

  ws.on("close", (code, reason) => {
    if (!authed) {
      console.error(
        `# ERROR socket closed before auth (code=${code} reason=${reason.toString() || "n/a"})`,
      );
      exitCode = exitCode || 1;
    } else {
      status(`socket closed code=${code} reason=${reason.toString() || "n/a"}`);
    }
    process.exit(exitCode);
  });

  ws.on("error", (err) => {
    console.error(`# ERROR EXCEPTION ws: ${(err as Error).message}`);
    exitCode = 1;
  });

  process.on("SIGINT", () => {
    status("SIGINT — closing");
    ws.close();
  });
}

// -----------------------------------------------------------------------------
// REPLAY PATH
//
// 1. Inline NDJSON pull-reader (mirrors src/providers/replay/ndjsonLineReader.ts)
// 2. Per-symbol stream with a one-element peek buffer.
// 3. Sorted-array sweep across heads, paced by a sim clock.
// -----------------------------------------------------------------------------

interface LineReader {
  next(): Promise<unknown | null>;
  close(): Promise<void>;
}

function openNdjson(filePath: string): LineReader {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let closed = false;
  let ended = false;
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;

  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
      rl.pause();
    }
  });
  rl.on("close", () => {
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  rl.on("error", (err) => {
    console.error(`# ERROR EXCEPTION ndjson read: ${(err as Error).message}`);
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });

  async function nextLine(): Promise<string | null> {
    if (closed) return null;
    if (queue.length > 0) {
      const line = queue.shift()!;
      if (!ended) rl.resume();
      return line;
    }
    if (ended) return null;
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
      rl.resume();
    });
  }

  return {
    async next(): Promise<unknown | null> {
      while (true) {
        const line = await nextLine();
        if (line === null) return null;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          return JSON.parse(trimmed);
        } catch {
          continue; // tolerate malformed lines
        }
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      rl.close();
      fileStream.destroy();
    },
  };
}

interface ReplayTrade {
  t: string;
  p: number;
  s: number;
}

interface SymStream {
  symbol: string;
  reader: LineReader;
  head: ReplayTrade | null;
  headMs: number; // +Infinity when ended
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readNextTrade(reader: LineReader): Promise<ReplayTrade | null> {
  const v = (await reader.next()) as ReplayTrade | null;
  if (!v || typeof v.t !== "string" || typeof v.p !== "number") return null;
  return v;
}

async function runReplay(
  symbols: string[],
  date: string,
  speed: number,
): Promise<void> {
  // backend/.replay-cache/<date>/<SYM>.ndjson
  // __dirname is backend/scripts (or backend/dist/.../scripts when compiled).
  // Walk up to the directory that contains a .replay-cache folder.
  const cacheDir = locateReplayCache();
  const dayDir = path.join(cacheDir, date);

  const speedTag = speed === 0 ? "ASAP" : `${speed}x`;
  status(`replay ${date} @ ${speedTag} symbols=${symbols.join(",")}`);
  status(`cache=${dayDir}`);

  const streams: SymStream[] = [];
  for (const symbol of symbols) {
    const file = path.join(dayDir, `${symbol}.ndjson`);
    if (!fs.existsSync(file)) {
      console.error(`# ERROR no cache file for ${symbol}: ${file}`);
      continue;
    }
    const reader = openNdjson(file);
    const head = await readNextTrade(reader);
    if (!head) {
      console.error(`# ERROR ${symbol}: file empty`);
      await reader.close();
      continue;
    }
    streams.push({
      symbol,
      reader,
      head,
      headMs: Date.parse(head.t),
    });
  }

  if (streams.length === 0) {
    console.error("# ERROR no replay streams could be opened");
    process.exit(1);
  }

  // Sim clock: simNow() = simStart + (Date.now() - wallStart) * speed
  // ASAP (speed=0) → +Infinity, drains the heap as fast as the loop allows.
  const simStartMs = Math.min(...streams.map((s) => s.headMs));
  const wallStartMs = Date.now();
  const simNow = (): number =>
    speed <= 0 ? Number.POSITIVE_INFINITY : simStartMs + (Date.now() - wallStartMs) * speed;

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    status("SIGINT — stopping replay");
  });

  while (!stopping) {
    // Find the stream with the smallest head ms.
    let head: SymStream | null = null;
    for (const s of streams) {
      if (s.head === null) continue;
      if (head === null || s.headMs < head.headMs) head = s;
    }
    if (head === null) {
      status("replay end (EOF)");
      break;
    }

    if (head.headMs > simNow()) {
      // Sleep until the next due trade (capped so we stay responsive).
      const wallDelay =
        speed <= 0 ? 0 : Math.max(1, Math.min(50, (head.headMs - simNow()) / speed));
      await sleep(wallDelay);
      continue;
    }

    // Emit the head trade.
    const trade = head.head!;
    console.log(
      fmtTradeLine(trade.t, head.symbol, trade.p, trade.s, `replay ${speedTag}`),
    );

    // Advance this stream.
    const nxt = await readNextTrade(head.reader);
    if (!nxt) {
      await head.reader.close();
      head.head = null;
      head.headMs = Number.POSITIVE_INFINITY;
    } else {
      head.head = nxt;
      head.headMs = Date.parse(nxt.t);
    }
  }

  for (const s of streams) {
    if (s.head !== null) await s.reader.close();
  }
  process.exit(0);
}

function locateReplayCache(): string {
  // Walk up from this file looking for a directory that contains
  // a `.replay-cache` folder. Default project layout puts it at
  // backend/.replay-cache.
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, ".replay-cache");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Fall back to backend/.replay-cache relative to the script (won't
      // exist, but emits a useful error path downstream).
      return path.resolve(__dirname, "..", ".replay-cache");
    }
    dir = parent;
  }
}

// -----------------------------------------------------------------------------
// main()
// -----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.mode === "live") {
    await runLive(args.symbols, args.feed);
  } else {
    await runReplay(args.symbols, args.date!, args.speed);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error(
    `# FATAL UNHANDLED rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
  );
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(`# FATAL UNHANDLED exception: ${err.stack ?? err.message}`);
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error(
    `# FATAL EXCEPTION main: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  process.exit(1);
});
