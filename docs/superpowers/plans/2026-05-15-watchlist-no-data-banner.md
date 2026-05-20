# Watchlist no-data banner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-row "No data" banner in the watchlist table when the active price provider cannot price a symbol (today: replay mode with a missing NDJSON file), instead of silently filtering the row out.

**Architecture:** Backend providers gain a synchronous `getUnavailableSymbols()` method that names which of the requested symbols cannot be priced and why. `GET /api/quotes` includes that information as an optional `unavailable` field on `QuotesResponse`. The frontend `useMarket` hook exposes the same map; `WatchlistPage` iterates the full watchlist and renders one of three row variants per ticker — priced, banner, or skip-while-loading.

**Tech Stack:** TypeScript end-to-end. Backend: Express 5, `pg-pool`, Socket.io, `tsc` build. Frontend: React 18, Vite, plain CSS modules. No test framework wired up — manual verification + tsc + eslint + a runtime curl.

**Spec:** `docs/superpowers/specs/2026-05-15-watchlist-data-source-ux-design.md`

---

## File map

```
shared/src/contracts/quote.ts             modify  (add UnavailableReason, extend QuotesResponse)
backend/src/providers/PriceProvider.ts    modify  (add getUnavailableSymbols to interface)
backend/src/providers/AlpacaProvider.ts   modify  (implement: returns {})
backend/src/providers/ReplayProvider.ts   modify  (implement: existsSync per symbol)
backend/src/routes/quotes.ts              modify  (call provider, attach to response)
frontend/src/hooks/useMarket.ts           modify  (track unavailable, expose on result)
frontend/src/App.tsx                      modify  (forward unavailable to WatchlistPage)
frontend/src/pages/WatchlistPage.tsx      modify  (3-state row rendering, banner JSX)
```

No new files. The codebase prefers modifying focused existing files over splitting up small components.

---

## Context engineers will need

- **Run the app:** `npm run deploy` from repo root rebuilds backend + frontend and `pm2 startOrReload`s the backend. Frontend is served by its own dev server (see `ports.cjs`: backend 5010, frontend 5011). Logs: `pm2 logs 5010_paper_trade_pro_backend`.
- **Backend rebuild only:** `cd backend && npm run build` (this is `tsc`). After editing backend code, you must rebuild AND `pm2 restart 5010_paper_trade_pro_backend` — pm2 runs `dist/backend/src/server.js`, not the source.
- **Frontend dev:** Vite hot-reloads automatically. No restart needed for frontend changes.
- **`exactOptionalPropertyTypes` is on** (`backend/tsconfig.json`): assigning `undefined` to an optional field is an error. Use conditional spreads (`...(cond ? { field: x } : {})`) when including optional fields.
- **`noUncheckedIndexedAccess` is on**: `record[key]` is typed as `T | undefined`. You must narrow before use.
- **Logging discipline (CLAUDE.md):** never swallow errors. The existing routes already comply; you should not need to add new log calls in this plan.
- **Replay cache layout:** `backend/.replay-cache/<YYYY-MM-DD>/<SYMBOL>.ndjson`. The cache for `2026-05-01` currently has only `TSLA.ndjson` — that's the verification fixture for "mixed availability".
- **Pill text today** (do not change): `App.tsx:316-343`. Current connected text is `Live · ${provider}` (e.g. `Live · replay`). The spec explicitly leaves this alone.

---

## Task 1: Add `UnavailableReason` to shared contracts

**Files:**
- Modify: `shared/src/contracts/quote.ts:50-56`

- [ ] **Step 1: Add the new interface and extend `QuotesResponse`**

Edit `shared/src/contracts/quote.ts`. Find the existing `QuotesResponse` (lines 50-56) and replace it plus add `UnavailableReason` immediately above:

```ts
/**
 * Why a particular symbol cannot be priced right now. Currently emitted
 * by the replay provider for symbols whose NDJSON file is missing for
 * the configured REPLAY_DATE. The discriminator lets us add new reasons
 * (unknown-symbol, fetch-failed, etc.) later without reshaping clients.
 */
export interface UnavailableReason {
  code: 'no-replay-data';
  /** Human-readable, ready to render verbatim in the UI. */
  message: string;
}

/** REST responses. */
export interface QuotesResponse {
  quotes: Record<string, Quote>;
  /** Provider-wide status (e.g. "unavailable" if creds are missing). */
  providerStatus: PriceStatus;
  /** Provider name (surfacing in UI for debug / "provider: alpaca"). */
  provider: string;
  /**
   * Symbols the provider knows it cannot price right now (e.g. replay
   * has no NDJSON file for the configured date). Keyed by symbol.
   * Optional so existing clients ignore it gracefully.
   */
  unavailable?: Record<string, UnavailableReason>;
}
```

- [ ] **Step 2: Verify the export tree picks it up**

Open `shared/src/index.ts` — it does `export * from './contracts/quote.js';`, so the new type is exposed automatically. No edit required, but confirm the file looks like:

```ts
export * from './contracts/quote.js';
export * from './contracts/events.js';
export * from './contracts/portfolio.js';
export * from './constants.js';
```

- [ ] **Step 3: Type-check shared + backend + frontend**

Run from repo root:
```bash
cd backend && npm run build
cd ../frontend && npx tsc -b --noEmit
```
Expected: both succeed. (No call sites yet use the new field, so this only validates the type itself.)

- [ ] **Step 4: Commit**

```bash
git add shared/src/contracts/quote.ts
git commit -m "shared: add UnavailableReason and optional QuotesResponse.unavailable"
```

---

## Task 2: Add `getUnavailableSymbols` to the `PriceProvider` interface

**Files:**
- Modify: `backend/src/providers/PriceProvider.ts`

- [ ] **Step 1: Extend the interface**

Edit `backend/src/providers/PriceProvider.ts`. Add `UnavailableReason` to the import from shared, and a new method on the interface:

```ts
import type {
  Bar,
  BarTimeframe,
  Quote,
  UnavailableReason,
} from '../../../shared/src';
```

Then inside the `PriceProvider` interface, after `updateSubscriptions`:

```ts
  /**
   * Synchronously report any of the requested symbols this provider knows it
   * cannot currently price. Returns an empty object when everything is fine.
   * Intentionally sync — implementations should be cheap (cached file-stat,
   * in-memory lookup). Don't make HTTP calls here.
   */
  getUnavailableSymbols(symbols: string[]): Record<string, UnavailableReason>;
```

- [ ] **Step 2: Run tsc to confirm both implementations now flag as missing**

```bash
cd backend && npm run build
```

Expected: 2 errors of the form
```
Class 'AlpacaProvider' incorrectly implements interface 'PriceProvider'.
  Property 'getUnavailableSymbols' is missing …
Class 'ReplayProvider' incorrectly implements interface 'PriceProvider'.
  Property 'getUnavailableSymbols' is missing …
```

That's the desired state — Tasks 3 and 4 fix them. Don't commit yet.

---

## Task 3: Implement `getUnavailableSymbols` on `AlpacaProvider`

**Files:**
- Modify: `backend/src/providers/AlpacaProvider.ts`

- [ ] **Step 1: Add an empty implementation**

Open `backend/src/providers/AlpacaProvider.ts`. Add `UnavailableReason` to the type-only import from shared (it currently imports `Bar, BarTimeframe, Quote`):

```ts
import type { Bar, BarTimeframe, Quote, UnavailableReason } from '../../../shared/src';
```

Add a method to the class (placement: anywhere among the other public methods; conventional spot is right after `updateSubscriptions`):

```ts
  getUnavailableSymbols(_symbols: string[]): Record<string, UnavailableReason> {
    // Alpaca doesn't expose per-symbol availability synchronously. Anything
    // unknown will surface as an empty Quote on fetchQuotes / a stream-side
    // error — same behavior as today.
    return {};
  }
```

- [ ] **Step 2: tsc**

```bash
cd backend && npm run build
```

Expected: only the `ReplayProvider` error remains.

---

## Task 4: Implement `getUnavailableSymbols` on `ReplayProvider`

**Files:**
- Modify: `backend/src/providers/ReplayProvider.ts:53-83` (class declaration + imports)

- [ ] **Step 1: Add the type import**

Open `backend/src/providers/ReplayProvider.ts`. Update the shared import:

```ts
import type { Bar, BarTimeframe, Quote, UnavailableReason } from '../../../shared/src';
```

- [ ] **Step 2: Add the method**

Place it right after `updateSubscriptions` (around line 202) and before the `// internals` comment, so it sits with the other public methods:

```ts
  getUnavailableSymbols(symbols: string[]): Record<string, UnavailableReason> {
    const out: Record<string, UnavailableReason> = {};
    for (const raw of symbols) {
      const sym = raw.toUpperCase();
      // pathFor() consults this.cfg.replay.cacheDir + replay.date — same path
      // openStreams() uses, so this answer is consistent with what the live
      // stream would do.
      if (!fs.existsSync(this.pathFor(sym))) {
        out[sym] = {
          code: 'no-replay-data',
          message: `No replay file for ${sym} on ${this.cfg.replay.date}.`,
        };
      }
    }
    return out;
  }
```

`fs` and `path` are already imported at the top of the file; no new imports needed.

- [ ] **Step 3: tsc**

```bash
cd backend && npm run build
```

Expected: clean build.

- [ ] **Step 4: Commit Tasks 2-4 together**

The interface change and its two implementations are coupled — a half-applied state doesn't compile. Commit them as one change:

```bash
git add backend/src/providers/PriceProvider.ts \
        backend/src/providers/AlpacaProvider.ts \
        backend/src/providers/ReplayProvider.ts
git commit -m "providers: add synchronous getUnavailableSymbols hook

ReplayProvider reports symbols whose NDJSON file is missing for the
configured REPLAY_DATE. AlpacaProvider returns empty (no equivalent
synchronous signal). The /quotes route will plumb this to the UI in a
follow-up commit."
```

---

## Task 5: Plumb `unavailable` through `GET /api/quotes`

**Files:**
- Modify: `backend/src/routes/quotes.ts:45-91`

- [ ] **Step 1: Compute and attach `unavailable` in the success path**

Open `backend/src/routes/quotes.ts`. In the `router.get("/quotes", …)` handler, after `const quotes = await deps.cache.getMany(symbols);` and after the `ensureSubscribed` block, change the response build (the existing `const body: QuotesResponse = { … }`) to:

```ts
      const unavailable = deps.provider.getUnavailableSymbols(symbols);

      const body: QuotesResponse = {
        quotes,
        providerStatus: deps.hub.getStatus().status,
        provider: deps.provider.name,
        ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
      };
      return res.json(body);
```

The conditional spread keeps the field absent (not `undefined`) when empty — required because `exactOptionalPropertyTypes` is on, and so the alpaca response is byte-identical to today's.

- [ ] **Step 2: Leave the catch path alone**

The existing `catch` block returns `{ quotes: {}, providerStatus: 'unavailable', provider: deps.provider.name }` and a 502. Do not add `unavailable` here — the request is already failing, the front end doesn't need a per-symbol explanation, and we don't want the provider's `getUnavailableSymbols` to fire when the upstream has just thrown.

- [ ] **Step 3: tsc**

```bash
cd backend && npm run build
```

Expected: clean.

- [ ] **Step 4: Manual verification — alpaca shape unchanged**

Restart pm2 with the current `.env` (which has `PRICE_PROVIDER=replay`):
```bash
pm2 restart 5010_paper_trade_pro_backend
curl -s "http://localhost:5010/api/quotes?symbols=TSLA,AMZN" | python3 -m json.tool
```
Expected JSON (TSLA file exists; AMZN does not in `2026-05-01`):
```json
{
    "quotes": {
        "TSLA": { "symbol": "TSLA", "price": 382.475, ... }
    },
    "providerStatus": "unavailable",
    "provider": "replay",
    "unavailable": {
        "AMZN": {
            "code": "no-replay-data",
            "message": "No replay file for AMZN on 2026-05-01."
        }
    }
}
```

- [ ] **Step 5: Manual verification — alpaca returns no `unavailable`**

Temporarily switch `.env`:
```
PRICE_PROVIDER=alpaca
```
```bash
pm2 restart 5010_paper_trade_pro_backend
curl -s "http://localhost:5010/api/quotes?symbols=TSLA" | python3 -m json.tool
```
Expected: response has no `unavailable` field at all.

Restore `.env` to `PRICE_PROVIDER=replay` afterwards (so the rest of the plan's manual verification works without re-toggling).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/quotes.ts
git commit -m "routes: include per-symbol unavailable map in /api/quotes response"
```

---

## Task 6: Track `unavailable` in `useMarket`

**Files:**
- Modify: `frontend/src/hooks/useMarket.ts`

- [ ] **Step 1: Import the new type**

Edit the existing import block at the top of `frontend/src/hooks/useMarket.ts`:

```ts
import type { Quote, UnavailableReason } from "../../../shared/src";
```

- [ ] **Step 2: Add to the result interface**

Replace the existing `UseMarketResult` interface (around line 19) with:

```ts
export interface UseMarketResult {
  market: Market;
  /** Symbols the backend can't price right now, with reason. Empty when none. */
  unavailable: Record<string, UnavailableReason>;
  liveConnected: boolean;
  providerStatus: "live" | "stale" | "unavailable";
  provider: string;
  /** Non-null when the latest snapshot fetch failed. */
  error: string | null;
}
```

- [ ] **Step 3: Add state + populate it from the snapshot response**

Inside `useMarket`, near the existing `useState<Market>({})` (line 77), add:

```ts
  const [unavailable, setUnavailable] = useState<
    Record<string, UnavailableReason>
  >({});
```

Then in `loadSnapshots` (currently lines 129-170), modify the success branch so that after `setProvider(response.provider)` / `setProviderStatus(response.providerStatus)` and the existing `setMarket(...)` block, you also reset `unavailable` to whatever the response says, restricted to the current `symbolList`:

```ts
      const fresh = response.unavailable ?? {};
      const next: Record<string, UnavailableReason> = {};
      for (const sym of symbolList) {
        const u = fresh[sym];
        if (u) next[sym] = u;
      }
      setUnavailable(next);
```

In the empty-`symbolList` early return at the top of `loadSnapshots`, also clear `unavailable`:

```ts
    if (symbolList.length === 0) {
      setMarket({});
      setUnavailable({});
      return;
    }
```

In the `catch` block, drop any stale entries (we no longer have an authoritative answer):

```ts
    } catch (err) {
      setError((err as Error).message);
      setMarket((prev) => {
        const next: Market = { ...prev };
        for (const sym of symbolList) {
          if (next[sym]) next[sym] = { ...next[sym], freshness: "error" };
        }
        return next;
      });
      setUnavailable({});
    }
```

- [ ] **Step 4: Return the new field**

The existing return at the bottom of the hook (around line 224) becomes:

```ts
  return {
    market,
    unavailable,
    liveConnected,
    providerStatus: derivedProviderStatus,
    provider,
    error,
  };
```

- [ ] **Step 5: tsc**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: clean. (No call site has destructured the new field yet, but the existing `App.tsx` destructure doesn't break — extra properties are allowed.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useMarket.ts
git commit -m "useMarket: surface per-symbol unavailability map"
```

---

## Task 7: Forward `unavailable` from `App.tsx` to `WatchlistPage`

**Files:**
- Modify: `frontend/src/App.tsx:104-105` (destructure) and `frontend/src/App.tsx:251-261` (`<WatchlistPage>` props)

- [ ] **Step 1: Destructure `unavailable` from `useMarket`**

Find this line (approx. 104-105):

```ts
  const { market, liveConnected, providerStatus, provider, error } =
    useMarket(interestingSymbols);
```

Change to:

```ts
  const { market, unavailable, liveConnected, providerStatus, provider, error } =
    useMarket(interestingSymbols);
```

- [ ] **Step 2: Pass it to `<WatchlistPage>`**

Find the `case 'watchlist':` branch in `renderPage()` (approx. 251-261):

```tsx
      case 'watchlist':
        return (
          <WatchlistPage
            market={market}
            portfolio={portfolio}
            toggleWatch={toggleWatch}
            onNavigate={onNavigate}
            onAdd={() => setAddOpen(true)}
            setTradeCtx={setTradeCtx}
          />
        );
```

Add `unavailable={unavailable}`:

```tsx
      case 'watchlist':
        return (
          <WatchlistPage
            market={market}
            unavailable={unavailable}
            portfolio={portfolio}
            toggleWatch={toggleWatch}
            onNavigate={onNavigate}
            onAdd={() => setAddOpen(true)}
            setTradeCtx={setTradeCtx}
          />
        );
```

- [ ] **Step 3: tsc — expect a `WatchlistPageProps` mismatch error**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: error like
```
Property 'unavailable' does not exist on type 'WatchlistPageProps'.
```
That's the desired state — Task 8 adds the prop. Don't commit yet.

---

## Task 8: Render the banner in `WatchlistPage`

**Files:**
- Modify: `frontend/src/pages/WatchlistPage.tsx`

- [ ] **Step 1: Import `UnavailableReason` and add the prop**

Top of `frontend/src/pages/WatchlistPage.tsx` — extend the type import:

```tsx
import type {
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
} from '../lib/types';
import type { UnavailableReason } from '../../../shared/src';
```

Then update `WatchlistPageProps` (around line 14):

```tsx
interface WatchlistPageProps {
  market: Market;
  unavailable: Record<string, UnavailableReason>;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
  onAdd: () => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
}
```

And destructure it (around line 23):

```tsx
export function WatchlistPage({
  market,
  unavailable,
  portfolio,
  toggleWatch,
  onNavigate,
  onAdd,
  setTradeCtx,
}: WatchlistPageProps) {
```

- [ ] **Step 2: Replace the row construction with a 3-state classifier**

Currently (lines 31-34):

```tsx
  const { watchlist } = portfolio;
  const rows = watchlist
    .map((t) => ({ ticker: t, m: market[t] }))
    .filter((r) => r.m);
```

Replace with:

```tsx
  const { watchlist } = portfolio;
  // Classify each watchlist ticker. Loading rows (no quote yet, no
  // unavailability info) are skipped — they resolve in the next snapshot
  // call, typically within a few hundred ms.
  type Row =
    | { kind: 'priced'; ticker: string; m: NonNullable<Market[string]> }
    | { kind: 'banner'; ticker: string; reason: UnavailableReason };
  const rows: Row[] = [];
  for (const t of watchlist) {
    const m = market[t];
    if (m) {
      rows.push({ kind: 'priced', ticker: t, m });
      continue;
    }
    const reason = unavailable[t];
    if (reason) rows.push({ kind: 'banner', ticker: t, reason });
  }
```

- [ ] **Step 3: Update the empty-state condition**

Find the existing `{rows.length === 0 && (<Empty …/>)}` block (around line 72-77). The condition is fine as-is — if both priced and banner rows are absent, the watchlist is empty and we render `<Empty>`. No change needed.

- [ ] **Step 4: Switch the row-rendering loop on `kind`**

The current map (around line 78-154) renders one variant. Replace the entire `{rows.map(({ ticker, m }) => { … })}` block with a discriminated render:

```tsx
        {rows.map((row) => {
          if (row.kind === 'banner') {
            const { ticker, reason } = row;
            return (
              <div
                key={ticker}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.3fr 1fr 1fr 0.8fr 0.6fr 0.4fr',
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div>
                  <div className="ticker">{ticker}</div>
                  <div className="company">
                    {/* Use the existing seedStocks lookup to get a friendly
                        name when we have one — keep parity with priced rows. */}
                  </div>
                </div>
                <div
                  style={{
                    gridColumn: '2 / 6',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--text-muted)',
                    fontSize: 12.5,
                  }}
                >
                  <span
                    className="chip"
                    style={{
                      background: 'rgba(245, 158, 11, 0.14)',
                      color: '#f59e0b',
                    }}
                  >
                    No data
                  </span>
                  <span>{reason.message}</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 4,
                    justifyContent: 'flex-end',
                  }}
                >
                  <button
                    className="btn sm ghost"
                    onClick={() => toggleWatch(ticker)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          }

          // priced row — unchanged from the previous implementation
          const { ticker, m } = row;
          const pct = dayChangePct(m);
          const change = dayChange(m);
          return (
            <div
              key={ticker}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.3fr 1fr 1fr 0.8fr 0.6fr 0.4fr',
                padding: '14px 16px',
                borderBottom: '1px solid var(--border)',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
              onClick={() => onNavigate('detail', ticker)}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = 'var(--bg-muted)')
              }
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              <div>
                <div className="ticker">{ticker}</div>
                <div className="company">{m.name}</div>
              </div>
              <div
                className="mono tnum"
                style={{ textAlign: 'right', fontWeight: 500 }}
              >
                <PriceCell value={m.price} prefix="$" />
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className={`mono tnum ${pct >= 0 ? 'up' : 'down'}`}>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(2)}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 2 }}>
                  <span className={`chip ${pct >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(pct)}
                  </span>
                </div>
              </div>
              <div
                className="mono tnum"
                style={{ textAlign: 'right', color: 'var(--text-muted)' }}
              >
                {m.volume != null ? fmtVol(m.volume) : '—'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <Sparkline
                  data={m.history.slice(-30)}
                  width={64}
                  height={24}
                />
              </div>
              <div
                style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="btn sm primary"
                  onClick={() => setTradeCtx({ ticker, side: 'buy' })}
                >
                  Trade
                </button>
                <button
                  className="btn sm ghost icon-only"
                  onClick={() => toggleWatch(ticker)}
                  title="Remove"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </div>
          );
        })}
```

- [ ] **Step 5: Add a friendly company name to the banner row**

In the banner row's empty `<div className="company">` block, use the existing `getStockMeta` lookup (already used elsewhere in the codebase via `lib/seedStocks`). Add this import at the top:

```tsx
import { getStockMeta } from '../lib/seedStocks';
```

Then change the banner row's company div to:

```tsx
                  <div className="company">
                    {getStockMeta(ticker).name}
                  </div>
```

(`getStockMeta` already falls back to the ticker symbol when no metadata is registered, so this is safe for unknown symbols.)

- [ ] **Step 6: tsc + lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/WatchlistPage.tsx
git commit -m "watchlist: render no-data banner row instead of filtering symbols out

Renders one row per watchlist symbol. Symbols the backend cannot price
(today: replay-mode missing NDJSON files) get a full-width banner with
the reason and a Remove button, replacing the silent filter that left
the table looking empty when 'N symbols tracked' said otherwise."
```

---

## Task 9: Manual verification

**Files:** none — runtime only.

- [ ] **Step 1: Replay, mixed availability**

`.env` has `PRICE_PROVIDER=replay`, `REPLAY_DATE=2026-05-01`. Watchlist already contains TSLA + 4 missing symbols (per the database row dump in the task that prompted this plan).

```bash
npm run deploy
```

Open http://localhost:5011, navigate to **Watchlist**.

Expected:
- TSLA row: priced, sparkline animates, Trade button.
- AMZN, COIN, TQQQ, SQQQ rows: each shows `[No data]` chip and the message `No replay file for <SYM> on 2026-05-01.` plus a Remove button.
- Sidebar badge "5" matches the row count (5 rendered: 1 priced + 4 banners).
- Top-right pill: `Live · replay` (or `Stale` / `Unavailable` if the scheduler is between reopens).

- [ ] **Step 2: Replay, all unavailable**

Edit `.env`: `REPLAY_DATE=1970-01-01`. Redeploy:
```bash
npm run deploy
```
Expected: every watchlist row is a banner, no table-empty state, no JS errors in the browser console. Restore `REPLAY_DATE=2026-05-01` and redeploy.

- [ ] **Step 3: Alpaca**

Edit `.env`: `PRICE_PROVIDER=alpaca`. Redeploy. (Run during US market hours for live ticks; outside hours, freshness chips will go stale but rows still render.)

Expected:
- No banner rows (alpaca's `getUnavailableSymbols` always returns `{}`).
- Watchlist behavior identical to before this change.

```bash
curl -s "http://localhost:5010/api/quotes?symbols=TSLA" | python3 -m json.tool
```
Expected: response has no `unavailable` key at all.

Restore `.env` to `PRICE_PROVIDER=replay` afterwards.

- [ ] **Step 4: Remove from a banner row**

Click `Remove` on (e.g.) AMZN. Expected:
- Row disappears immediately.
- Sidebar badge decrements.
- Database `watchlist` row for AMZN is gone (`POST /api/watchlist/toggle` already wired).

- [ ] **Step 5: No banner-row crash on un-known seedStocks ticker**

Use the Add Stock modal to add `XYZQ` (a ticker not in `STOCK_META` and not in any replay folder).

Expected: a banner row renders with ticker `XYZQ` and company name `XYZQ` (the fallback from `getStockMeta`); no console errors.

- [ ] **Step 6: Final commit if any cleanups landed during verification**

If verification surfaced no fixes, skip. Otherwise commit and re-verify before declaring done.

---

## Self-review notes

**Spec coverage:**

- Spec §3 row states (Priced / No data / Loading) → Task 8 step 2 (classifier).
- Spec §3.2 banner layout (`grid-column: 2 / 6`, `[No data]` chip, Remove button) → Task 8 step 4.
- Spec §3.3 unchanged top-right pill → no task touches it. Verified during Task 9 step 1.
- Spec §5.1 shared types → Task 1.
- Spec §5.2/5.3/5.4 provider impls → Tasks 2-4.
- Spec §5.5 route → Task 5.
- Spec §5.6 useMarket → Task 6.
- Spec §5.7 App → Task 7.
- Spec §5.8 WatchlistPage → Task 8.
- Spec §6 error handling (catch path leaves response shape alone, no try/catch around `getUnavailableSymbols`) → Task 5 step 2 explicitly preserves this.
- Spec §7 logging (no new logs) → no task adds them.
- Spec §8 testing → Task 9.
- Spec §9 (single-commit ship) → relaxed to per-task commits for review-friendliness, but all under one branch and trivially squashable.

**Type/name consistency:**

- `UnavailableReason` referenced identically in shared, both providers, route, hook, App, and page.
- `unavailable` field name consistent across `QuotesResponse`, `UseMarketResult`, `WatchlistPageProps`.
- `getUnavailableSymbols` (not `getUnavailable` or `unavailableSymbols`) consistent across interface and both implementations.
- `code: 'no-replay-data'` literal consistent between Task 1 (type) and Task 4 (emit). UI only renders `message`, so adding new codes later doesn't require UI changes.

**No placeholders:** all code blocks contain runnable code; all paths are absolute or rooted at the repo. No "implement appropriate handling" / "add error handling" / "TBD".
