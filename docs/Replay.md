# Replay

`replay` is an off-hours alternative to the live Alpaca feed. It downloads a slice of real historical trades to disk, then plays them back through the **same `PriceProvider` interface** the live feed uses — so the rest of the app (REST `/api/quotes`, `/api/bars`, Socket.io `price:tick`, the chart, the order engine) sees identical events whether the source is live ticks or yesterday's NDJSON.

Use it when:

- The U.S. market is closed and you need ticks to develop against.
- You want a **deterministic** stream (same trades every run) for debugging.
- You want to **stress-test** the pipeline by draining hours of trades in seconds (`REPLAY_SPEED=0`).

## Timezone conventions

There are exactly two conventions in this pipeline. Memorize them and the rest is mechanical:

| Where | Timezone | Why |
| ----- | -------- | --- |
| Everything **on disk** and **on the wire** — `meta.json` `startIso`/`endIso`/`firstTradeIso`/`lastTradeIso`/`downloadedAt`, every NDJSON trade `"t"` field, every in-memory `Date.parse()` result. | **UTC** (RFC-3339, `Z` suffix; nanosecond precision on trade `"t"`). | Alpaca's REST API returns UTC; storing UTC end-to-end means no DST surprises and timestamps are directly comparable as numeric epoch-ms across symbols. |
| **CLI args** (`HH:MM` start/end) and **cache folder names** (`YYYY-MM-DD`). | **America/New_York wall-clock** (auto-handles EST ↔ EDT via `Intl.DateTimeFormat`, see `fetchTrades.ts:149`). | That's how traders think about a trading day — "09:30–16:00 ET" is unambiguous; "13:30–20:00 UTC" is correct half the year and wrong the other half. |

Worked example for May 2026 (EDT, UTC−4):

```bash
npm run fetch-trades -- TSLA 2026-05-15
# → window:    09:30–16:00 ET   (CLI default)
# → startIso:  2026-05-15T13:30:00.000Z   (UTC, written to meta.json)
# → endIso:    2026-05-15T20:00:00.000Z
# → first tr:  2026-05-15T13:30:00.141Z   (= 09:30:00.141 ET)
```

In January (EST, UTC−5) the same CLI would produce `14:30–21:00 UTC` — `etWallClockToUtcIso` picks the right offset for the date you supplied.

The frontend displays whatever the browser's locale produces from those UTC values; it doesn't assume anything about the user's timezone.


## FAQ — common questions

### When does replay actually start playing?

The provider starts the moment the backend boots, **but it only emits ticks for symbols that have been subscribed to the WebSocket stream.** That subscription is driven by the frontend, not by what's on disk.

Concretely:
1. `server.ts:116` calls `hub.start([])` — the upstream stream opens with an **empty** symbol set.
2. When the UI requests `GET /api/quotes?symbols=A,B,C` (typically right after the watchlist page mounts), the route handler calls `deps.hub.ensureSubscribed(symbols)` (`backend/src/routes/quotes.ts:66`), which forwards to `ReplayProvider.updateSubscriptions`.
3. `updateSubscriptions` (`ReplayProvider.ts:186`) opens a per-symbol NDJSON reader, reads the first trade, and pushes it onto the heap.
4. If the heap was empty, `anchorClock()` (`ReplayProvider.ts:286`) re-anchors the simulated clock to the new earliest trade. **Nothing is emitted before the first symbol subscribes.**

Side effect of starting with an empty subscription set: the scheduler runs once, finds the heap empty, and immediately emits `provider:status = disconnected ("replay ended")` (`ReplayProvider.ts:318`). You'll see that in `pm2 logs` right after startup. The pill briefly reads "Stale" / "Unavailable" until the watchlist page mounts and triggers `ensureSubscribed`. This is normal and harmless.

Bottom line: open the watchlist page → backend subscribes → first tick lands within ~20 ms (the scheduler tick interval).

### What is the replay speed?

Controlled by `REPLAY_SPEED` (default `1`):

| Value | Behavior |
|---|---|
| `1` | **Real-time.** A trade timestamped 09:30:01 emits one second after the trade timestamped 09:30:00. |
| `10` | **10× faster.** That same gap shrinks to 100 ms. |
| `0` (or any value `<= 0`) | **As-fast-as-possible.** `simNow()` returns `+Infinity`, so the scheduler drains the entire heap each 20 ms wake-up. Useful for stress-testing. |
| `0.5`, `2`, `60`, etc. | Linear scaling — fractional and large values are accepted. The math is `simStartMs + (Date.now() - wallStartMs) * speed` (`ReplayProvider.ts:296`). |

The speed is read once per scheduler tick, so changing it requires a backend restart.

### I have one hour of trades — how long does replay take?

Depends on `REPLAY_SPEED`:

| Speed | One hour of trades plays in |
|---|---|
| `1` (real-time) | ~60 minutes |
| `10` | ~6 minutes |
| `60` | ~1 minute |
| `0` (ASAP) | A few seconds — bounded by disk I/O, JSON parsing, and Socket.io fan-out, **not** by trade timestamps. For a single symbol with ~10k trades, expect <1 s. |

Caveats:
- The clock is anchored to the **earliest un-emitted trade across all subscribed streams** (`anchorClock`, line 286). So if you fetched 09:30–10:30 and only TSLA is subscribed, "wall-clock zero" is TSLA's first trade timestamp — there is no warm-up gap.
- `REPLAY_SPEED=0` is async-bounded: the scheduler still wakes every 20 ms (`startScheduler`, line 323). At each wake it drains the heap, so a 60-minute window typically completes in a handful of timer ticks. If you want truly synchronous playback for a test, use `backend/scripts/testReplay.ts` directly with `speed=0`.

### What happens after replay ends?

Two outcomes, picked by `REPLAY_LOOP`:

| `REPLAY_LOOP` | Behavior at EOD |
|---|---|
| `true` (default) | `reopenLoop()` (`ReplayProvider.ts:372`) closes every reader, reopens them at line 1, re-anchors the sim clock, and the scheduler resumes after a 50 ms pause. **The price will jump discontinuously back to the open** — the chart will see one large negative tick, and any trailing-stop logic should be aware of this. The UI's status pill stays connected. |
| `false` | `handlers.onStatusChange("disconnected", "replay ended")` is emitted (`ReplayProvider.ts:319`), `PriceStreamHub` rebroadcasts that status, and the top-right pill flips to "Stale" / "Unavailable". The scheduler stops. The last-known price stays in `lastPrice` and is still returned by `fetchQuotes` — the chart freezes on the final tick. |

There is no automatic "advance to the next REPLAY_DATE" — see the next question.

### I have multiple days of data — which day plays first?

**Whichever single date is in `REPLAY_DATE`. Only one date plays per run.**

`ReplayProvider.pathFor(symbol)` (`ReplayProvider.ts:206`) hard-codes the path as `<cacheDir>/<replay.date>/<SYMBOL>.ndjson`, where `replay.date` is the `REPLAY_DATE` env var resolved at startup. The provider has no notion of "next day" — even with `2026-05-01`, `2026-05-04`, and `2026-05-15` all on disk, only the configured date is read.

To verify what's on disk:

```bash
ls backend/.replay-cache/
# → 2026-05-01  2026-05-04  2026-05-15
```

### How do I choose / sequence the replay order across multiple days?

Three options, in order of effort:

**1. Manual restart between days.**
Edit `.env`, change `REPLAY_DATE`, run `pm2 restart 5010_paper_trade_pro_backend`. The provider re-reads the env on boot. Simple, works today, no code changes.

**2. Shell-loop the restart.**
For a deterministic sequence, drive it from the shell:

```bash
for d in 2026-05-01 2026-05-04 2026-05-15; do
  sed -i '' "s/^REPLAY_DATE=.*/REPLAY_DATE=$d/" .env
  pm2 restart 5010_paper_trade_pro_backend
  # Wait however long the day takes at your speed setting:
  #   1 trading day @ speed=10  ≈ 39 min
  #   1 trading day @ speed=0   ≈ a few seconds
  sleep 60
done
```

This is good for stress-testing or long-running soaks, but each restart drops the WebSocket — connected clients reconnect automatically.

**3. (Future, not implemented today.)**
A multi-date sequencer inside `ReplayProvider` would need:
- Accept `REPLAY_DATES=2026-05-01,2026-05-04,2026-05-15` instead of (or alongside) `REPLAY_DATE`.
- On EOD with looping off, advance `cfg.replay.date`, rebuild `pathFor` URLs, and call `openStreams` again — basically `reopenLoop()` but pointed at the next folder.
- Decide what `anchorClock` does at the boundary (jump-cut to next day's first trade vs. preserve a wall-clock cadence).

That work hasn't been scoped — file an issue if you want it. Until then, options 1 and 2 cover the use cases.

### What ordering do trades have *within* a single day?

Strictly chronological, merged across symbols:
- Each symbol's NDJSON file is in chronological order (the downloader writes pages in order — `fetchTrades.ts:355`).
- The min-heap (`backend/src/providers/replay/minHeap.ts`) keys on the next-trade timestamp per symbol, so the global stream is sorted by trade time.
- Within a single millisecond, the heap's tie-breaking is whatever order entries happen to land on it — the API doesn't promise anything finer than millisecond ordering.

## TL;DR

```bash
# 1. Download an hour of TSLA trades into backend/.replay-cache/2026-05-01/TSLA.ndjson
cd backend && npm run fetch-trades -- TSLA 2026-05-01 09:30 10:30

# 2. Switch the backend over to replay
echo 'PRICE_PROVIDER=replay' >> .env
echo 'REPLAY_DATE=2026-05-01' >> .env

# 3. Restart the backend — the frontend is unchanged.
```

## Step 1 — Get the data: `fetchTrades.ts`

Downloads historical trades from Alpaca's REST `/v2/stocks/trades` endpoint and writes them to a local NDJSON file (one trade per line). Trades are written in chronological order, so playback can stream them sequentially.

Source: `backend/scripts/fetchTrades.ts`. Wired up as `npm run fetch-trades` in `backend/package.json:11`.

### Usage

```bash
cd backend
npm run fetch-trades -- <SYMBOL> <YYYY-MM-DD> [<HH:MM> <HH:MM>] [flags]
```

Arguments are **wall-clock America/New_York** — the script converts them to UTC ISO strings before calling Alpaca, so it picks the correct EST/EDT offset automatically (`backend/scripts/fetchTrades.ts:145`).

| Arg | Example | Notes |
|---|---|---|
| `SYMBOL` | `TSLA` | Ticker, validated against `^[A-Za-z.]{1,8}$`. |
| `YYYY-MM-DD` | `2026-05-01` | Trading date in ET. |
| `start HH:MM` | `09:30` | Window start (ET). Optional — defaults to `09:30` (RTH open). |
| `end HH:MM` | `16:00` | Window end (ET). Optional — defaults to `16:00` (RTH close). Must be ≥ start when provided. |

> **Why RTH-only by default?** The IEX feed is too sparse during pre-market (04:00–09:30 ET) and after-hours (16:00–20:00 ET) — often minutes between prints. At `REPLAY_SPEED=1` that makes the UI look frozen for many wall-clock minutes before the regular session starts. Pass explicit start/end times if you actually want the extended session, e.g. `... 04:00 20:00`.

| Flag | Default | Purpose |
|---|---|---|
| `--feed iex\|sip` | env `ALPACA_FEED` or `iex` | `iex` is free, `sip` requires a paid Alpaca subscription. |
| `--out <path>` | `backend/.replay-cache/<date>` | Override output directory. |
| `--force` | off | Overwrite an existing NDJSON file. Without this, the script aborts if `<symbol>.ndjson` already exists and is non-empty. |

### Examples

```bash
# Free-tier IEX feed, half-hour of TSLA
cd backend && npm run fetch-trades -- TSLA 2026-05-01 09:30 10:00

# Whole regular trading session (09:30–16:00 ET) — omit the time range
cd backend && npm run fetch-trades -- TSLA 2026-05-01

# Extended session (pre-market + after-hours) — pass times explicitly
cd backend && npm run fetch-trades -- TSLA 2026-05-01 04:00 20:00

# Paid SIP feed
cd backend && npm run fetch-trades -- AAPL 2026-05-01 09:30 16:00 --feed sip

# Re-download
cd backend && npm run fetch-trades -- TSLA 2026-05-01 09:30 10:00 --force
```

### Output layout

```
backend/.replay-cache/
└── 2026-05-01/
    ├── TSLA.ndjson         # one Alpaca trade record per line
    └── TSLA.meta.json      # { symbol, date, startIso, endIso, feed, count, pages, downloadedAt, firstTradeIso, lastTradeIso }
```

Each line in the NDJSON file is the raw Alpaca trade shape:

```json
{"t":"2026-05-01T13:30:00.123456789Z","x":"V","p":189.20,"s":100,"c":["@","T"],"i":12345,"z":"C"}
```

`t` = RFC-3339 UTC timestamp (nanosecond precision), `p` = price, `s` = size in shares. `ReplayProvider` reads `t` and `p` plus optional `s` for bar volumes.

### Auth

Reuses the same `APCA_KEY_ID` / `APCA_SECRET_KEY` env vars the runtime reads (`backend/scripts/fetchTrades.ts:203`). No extra setup. The base URL defaults to `https://data.alpaca.markets` and can be overridden with `ALPACA_DATA_URL`.

### Pagination & retries

The script paginates with Alpaca's `next_page_token` (10 000 trades per page) and sleeps 250 ms between pages to stay under the 200 req/min free-tier limit. It retries `429` and `5xx` responses with exponential backoff up to 5 attempts; non-retryable `4xx` errors abort immediately (`backend/scripts/fetchTrades.ts:355`).

The cache directory is gitignored — files are local-only.

## Step 2 — Play the data: `ReplayProvider`

When `PRICE_PROVIDER=replay`, the provider factory at `backend/src/providers/index.ts:10` instantiates `ReplayProvider` instead of `AlpacaProvider`. Both implement the same interface (`backend/src/providers/PriceProvider.ts:17`), so:

- REST `/api/quotes` calls `provider.fetchQuotes(symbols)` — `ReplayProvider` returns the most recent emitted price per symbol (or peeks the first NDJSON line if nothing has been emitted yet).
- REST `/api/bars` calls `provider.fetchBars(symbol, timeframe, limit)` — `ReplayProvider` reads the symbol's NDJSON file once and aggregates trades into OHLC bars on the fly, cached per `symbol|timeframe`.
- Socket.io `price:tick` events come from `provider.startStream()` — `ReplayProvider` schedules emissions on a simulated clock.

### Configuration (env vars)

All are documented in [`docs/ENV.md`](./ENV.md). Defaults are picked so a bare `PRICE_PROVIDER=replay` "just works" if you've downloaded `2026-05-01`.

| Var | Default | Purpose |
|---|---|---|
| `PRICE_PROVIDER` | `alpaca` | Set to `replay` to switch. |
| `REPLAY_DATE` | `2026-05-01` | Folder under `REPLAY_CACHE_DIR` to read (`<cacheDir>/<date>/<SYMBOL>.ndjson`). |
| `REPLAY_SPEED` | `1` | `1` real-time, `10` ten-times faster, `0` as-fast-as-possible (drain ASAP — useful for stress tests). |
| `REPLAY_LOOP` | `true` | When the last trade is emitted, reopen all readers from the start so the feed never dies. Set `false` to emit `disconnected` at EOD. |
| `REPLAY_CACHE_DIR` | `backend/.replay-cache` | Absolute path override for the NDJSON root. |

### How playback works

`backend/src/providers/ReplayProvider.ts`. The architecture mirrors a streaming merge-sort:

1. **One reader per subscribed symbol** (`openStreams`, line 234). Each reader is a pull-based async iterator that reads the NDJSON file line by line without buffering the whole file (`backend/src/providers/replay/ndjsonLineReader.ts`).
2. **A min-heap keyed by next-trade timestamp** (`backend/src/providers/replay/minHeap.ts`) merges the per-symbol streams into one global chronological order.
3. **A simulated clock** maps real wall-clock time to "replay time":
   - `simStartMs` is anchored to the earliest trade across all subscribed streams (`anchorClock`, line 264).
   - `simNow() = simStartMs + (Date.now() - wallStartMs) * REPLAY_SPEED` (line 271).
   - When `REPLAY_SPEED <= 0`, `simNow()` returns `+Infinity`, which drains the heap as fast as JS can run.
4. **The scheduler** (`startScheduler`, line 277) wakes every 20 ms, pops every heap entry whose timestamp is `<= simNow()`, emits the corresponding trade as a `Quote`, advances that symbol's reader, and re-pushes the next trade.
5. **Looping** (`reopenLoop`, line 350): when the heap empties and `REPLAY_LOOP=true`, every reader is closed and reopened from line 1 so the feed continues indefinitely.

### Timestamp mapping

`emitTrade` (line 333) sets the emitted `Quote.timestamp` to **`Date.now()`**, not the trade's original timestamp. This is intentional: the frontend's stale-detection (`VITE_STALE_AFTER_MS`) compares against `Date.now()`, so emitting historical timestamps would make every replayed quote look stale. The original trade time is still tracked internally for ordering — only the emitted quote's `timestamp` is rewritten.

### Subscription dynamics

- `startStream(initialSymbols, handlers)` opens readers for the initial set, anchors the clock, and emits `provider:status = connected` with detail `replay <date> @ <speed>x`.
- `updateSubscriptions(symbols)` diffs against the current set; new symbols get a fresh reader pushed onto the heap, removed symbols have their reader closed.
- The unsubscribe returned by `startStream` clears the scheduler timer, closes all readers, and resets the heap.

### Missing files

If a subscribed symbol has no NDJSON file under `<cacheDir>/<REPLAY_DATE>/`, the provider emits `provider:status = error` with detail `replay: no data for <SYMBOL> on <date>` (`openStreams`, line 239) and continues with the symbols that do have data. Fix it by running `npm run fetch-trades` for that symbol/date.

## Step 3 — Verify with the smoke-test script

`backend/scripts/testReplay.ts` is a self-contained smoke test that does **not** need `.env` or a database — it builds a stub config, starts a `ReplayProvider`, and prints ticks. Use it to confirm a freshly-downloaded NDJSON file plays correctly before flipping the runtime over.

```bash
cd backend
# defaults: 2026-05-01, TSLA, 20 ticks, speed=0 (ASAP)
npx tsx scripts/testReplay.ts

# explicit
npx tsx scripts/testReplay.ts 2026-05-01 TSLA 50      # 50 ticks
npx tsx scripts/testReplay.ts 2026-05-01 TSLA 20 0    # speed=0, ASAP
npx tsx scripts/testReplay.ts 2026-05-01 TSLA 20 1    # speed=1, real-time
```

Expected output:

```
→ Replay smoke test: TSLA on 2026-05-01 (speed=0)
→ Cache dir:        /…/backend/.replay-cache
→ Stopping after:   20 ticks

  <status> connected: replay 2026-05-01 @ 0x
  [#   1] TSLA $189.200 @ 2026-05-15T17:42:11.123Z
  [#   2] TSLA $189.205 @ 2026-05-15T17:42:11.124Z
  …
✔ Received 20 ticks in 0.04s
```

The script auto-stops after either `maxTicks` ticks, the provider emits `disconnected` (EOD with looping off), or a 30-second safety timeout.

## Limitations

- **Trades only — no quotes (bid/ask).** The downloader hits `/v2/stocks/trades`, so emitted quotes have `bid: null` and `ask: null`. The depth-of-book columns in the UI will be empty under replay; market orders fall back to the last trade price. (`buildQuote`, `backend/src/providers/ReplayProvider.ts:360`).
- **Bars are derived, not historical.** `fetchBars` re-buckets the NDJSON trades into OHLC at request time — accuracy is bounded by the trades you downloaded. If you fetched only 09:30–10:30, a `1Day` bar will only cover that window.
- **Loop creates time discontinuities.** With `REPLAY_LOOP=true`, the price will instantly jump back to the open at the moment of wraparound. The chart and any trailing-stop logic will see that as one large negative tick.
- **Single date per run.** The provider reads one folder (`REPLAY_DATE`). To replay multiple sessions back-to-back, restart the backend with a new `REPLAY_DATE`.
- **Cache files are local.** `backend/.replay-cache/` is gitignored — every developer downloads their own copy. Free-tier IEX-only feed is sufficient for dev; SIP requires a paid Alpaca account.

## Source map

| File | What it does |
|---|---|
| `backend/scripts/fetchTrades.ts` | Downloader CLI. Paginated REST fetch + NDJSON writer. |
| `backend/scripts/testReplay.ts` | Standalone smoke test for `ReplayProvider`. |
| `backend/src/providers/ReplayProvider.ts` | The provider itself: REST snapshots, bar derivation, scheduled tick emission. |
| `backend/src/providers/replay/ndjsonLineReader.ts` | Pull-based async line reader (no whole-file buffering). |
| `backend/src/providers/replay/minHeap.ts` | Generic typed min-heap used to merge per-symbol streams chronologically. |
| `backend/src/providers/index.ts` | Factory — picks `AlpacaProvider` vs `ReplayProvider` from `cfg.provider`. |
| `backend/src/config.ts` | Validates `REPLAY_*` env vars, exposes `cfg.replay`. |
| `shared/src/constants.ts` | `PROVIDERS = ["alpaca", "replay"]` — the source of truth for valid `PRICE_PROVIDER` values. |
