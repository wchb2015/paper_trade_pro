## Golden Rule: Never fail silently.

If any function, API call, async operation, DB query, background job, file operation, auth flow, or external service fails:

1. The error MUST be:
   - logged with `error` severity
   - include the original exception/error object
   - include contextual metadata
   - visible in console or dedicated log output

2. At minimum log:
   - timestamp
   - operation/function name
   - error message
   - stack trace
   - request/user/context identifiers when available

3. Use explicit error keywords:
   - `ERROR`
   - `FATAL`
   - `EXCEPTION`
   - `UNHANDLED`

4. Never swallow exceptions with:
   - empty `catch {}`
   - catch-only comments
   - ignored promise rejections
   - returning `null`/`undefined` without logging

5. If an error is intentionally handled gracefully:
   - still log it
   - explain fallback behavior in logs

6. All catch blocks must do at least one:
   - `logger.error(...)`
   - `console.error(...)`
   - write to dedicated error log file
   - send to monitoring service (Sentry, Datadog, etc.)

7. Async rules:
   - no unhandled promises
   - always await or explicitly `.catch()`
   - background jobs must have top-level error handlers

8. API rules:
   - log all 5xx failures
   - log unexpected 4xx validation/auth failures when useful
   - never return generic success when internal operation failed

9. Database rules:
   - log failed queries/transactions
   - log rollback reasons
   - log connection failures

10. Frontend rules:
   - React/Next.js must use error boundaries where appropriate
   - failed fetches must log detailed errors
   - hydration/render failures must not be ignored

## Rule: Pagination
* keep previous rows visible while the next page is loading so paginating the transactions table no longer flickers to an empty/spinner state.

## Rule: Timezone — The Golden Rule

| Rule | Why |
| ---- | --- |
| **Always transport/store as UTC** | One universal truth — no ambiguity |
| **Only convert to local time at the display edges** | Browser on input (`.toISOString()`) and on output (`.toLocaleString()`) |
| **Server should be a timezone-ignorant pipe** | Don't create `new Date()` on the server for user-facing times |
| **Use `timestamptz`, not `timestamp`** | `timestamptz` auto-converts; `timestamp` doesn't and can cause bugs |

---

### What Can Go Wrong?

| Mistake | What Happens |
| ------- | ------------ |
| Sending `"2026-03-15T10:00"` (no Z, no offset) to backend | Backend/DB might interpret it as server timezone instead of user timezone |
| Using `timestamp` instead of `timestamptz` | PostgreSQL stores the literal value without any conversion — if different clients send different offsets, you get inconsistent data |
| Doing `new Date()` on the server for user-meaningful times | Uses server timezone, not user timezone |
| Forgetting `.toISOString()` on the frontend | The datetime-local value has no timezone info and will be misinterpreted |

---

### The Correct Pattern ✅

1. **Frontend:** `new Date(localValue).toISOString()` → converts user's local time to UTC
2. **Backend:** Pass-through, no timezone manipulation
3. **Database:** `timestamptz` stores as UTC
4. **Display:** Browser's `new Date(utcString)` automatically shows in user's local timezone

The only thing to remember: **the user's timezone is only known in the browser**. Everything else works in UTC.

### Date-Only Values (YYYY-MM-DD)

For date-only strings (no time component), **use local date methods**, not `.toISOString()`:

```ts
// ✅ Correct — uses local date
const year = date.getFullYear();
const month = String(date.getMonth() + 1).padStart(2, '0');
const day = String(date.getDate()).padStart(2, '0');
return `${year}-${month}-${day}`;

// ❌ Wrong — converts to UTC first, can shift the date after 5 PM PDT
return date.toISOString().split("T")[0];
```

## Rule: Postgres search_path — The Other Golden Rule

| Rule | Why |
| ---- | --- |
| **Set `search_path` at the DB role level, never in app code.** | `ALTER ROLE <role> SET search_path = <schema>, public` is applied when Postgres spawns a backend session and survives PgBouncer / Neon transaction-pooler resets. |
| **Do not run `SET search_path` inside `pg.Client.connect()`, a `pool.on('connect')` listener, or the startup `options=-c search_path=…` parameter.** | Neon's pooled endpoint rejects startup `options` with SQLSTATE `08P01`. Per-session `SET` is also fragile under transaction pooling: the SET lands on one backend, the next query may land on a different backend, and the narrowed path silently reverts to Postgres's default `"$user", public` → `42P01 relation "<table>" does not exist` on the first few queries after a Neon compute cold-start or `pm2 restart`. |
| **If you need strict schema isolation instead of a wide default, fully-qualify table names.** | `image_cloud.images` is immune to `search_path` drift. |

### What went wrong once (so the next engineer doesn't repeat it)

We subclassed `pg.Client` and awaited `SET search_path TO "image_cloud", public` inside `connect()`. It worked under warm pool conditions and failed with `42P01 relation "images" does not exist` on the first few queries after a Neon compute cold-start, because PgBouncer was swapping backends between the SET and the subsequent query. The fix was:

1. Delete the subclass. `backend/src/db.ts` now creates a plain `new pg.Pool({ connectionString })` with no per-connection ceremony.
2. Rely entirely on the DB-level role default already set with `ALTER ROLE <role> SET search_path = …`.

Do not re-introduce per-client `SET search_path`, even "as defense-in-depth" — it's a net negative under transaction pooling.     