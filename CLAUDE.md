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