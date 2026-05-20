# Landing Page + Google Auth + Responsive Audit — Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public landing page, Google OAuth sign-in, a read-only `/demo` mode, and a responsive audit of the existing app — across four small, independently-shippable PRs.

**Architecture:** Same-origin everywhere (Vite proxy in dev, nginx in prod) so the session cookie story is one story. DB-backed sessions, server-side OAuth via `google-auth-library`. The current hardcoded `cfg.currentUserId` becomes the demo user; `getUserId(req)` becomes the auth swap point. Landing page is a sibling surface mounted by `main.tsx` based on `GET /api/auth/me`.

**Tech Stack:** React 19 + Vite + TypeScript (frontend), Express 5 + Socket.io + pg (backend), PostgreSQL 18 (Neon), `google-auth-library` (new), `cookie-parser` (new), `concurrently` (devDep).

**Spec:** [`docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md`](../specs/2026-05-19-landing-page-and-google-auth-design.md)

**No test runner** is installed in this repo. Verification per task = `npx tsc -b` (or `cd backend && npx tsc`) + `npx eslint <touched-file>` + targeted manual smoke. The full per-phase verification checklist comes from spec §6.5.

---

## Phase plans (each is its own file)

The phases are independent PRs and each phase has its own dedicated plan file. Execute them in order.

| Phase | What lands | Plan |
|---|---|---|
| **Phase 0** | Same-origin plumbing — Vite proxy, relative URLs, `npm run dev`, `Local_Dev.md`. No behavior change. | [`2026-05-19-landing-phase-0-same-origin.md`](./2026-05-19-landing-phase-0-same-origin.md) |
| **Phase 1** | Auth backbone — `users` + `sessions` tables, `/api/auth/*`, `requireAuth`, `/api/demo/*`, `BYPASS_AUTH`, swap `getUserId`. No UI changes. | [`2026-05-19-landing-phase-1-auth-backbone.md`](./2026-05-19-landing-phase-1-auth-backbone.md) |
| **Phase 2** | Landing page + auth UI — `/landing/`, `AuthBoot`, 30-line router, sign-out in TopBar, demo CTA. | [`2026-05-19-landing-phase-2-landing-and-auth-ui.md`](./2026-05-19-landing-phase-2-landing-and-auth-ui.md) |
| **Phase 3** | Responsive audit of the existing app — sidebar drawer, compact TopBar, breakpoint drop, touch targets, table scroll, OrdersPage at <480px. | [`2026-05-19-landing-phase-3-responsive-audit.md`](./2026-05-19-landing-phase-3-responsive-audit.md) |

After every phase: `npx tsc -b`, `npm run build`, smoke the relevant checklist in spec §6.5, then commit and open the next phase as its own PR.

---

## Cross-phase invariants

These hold across every phase. Re-read them if you ever feel uncertain.

1. **Same-origin everywhere.** The browser always talks to its current origin (Vite `:5011` in dev, `papertrade.pro` in prod). Backend lives behind `/api/*` and `/socket.io/*` on that same origin. There are zero cross-origin XHR calls in the frontend after Phase 0.
2. **Logging discipline (CLAUDE.md golden rule).** Every `catch` logs with the original error and an operation name at `error` severity. Every new auth path includes `authOp` in its log payload (one of `start | callback | me | logout | demo_attach | readonly_block`).
3. **Timezones (CLAUDE.md rule).** Every new `timestamptz` column lives untouched at the DB and is rendered in the user's locale on the frontend. No `new Date()` on the server for user-facing values.
4. **Postgres `search_path`.** Do not introduce any per-client `SET search_path`. The DB role default is set; new tables fully-qualify or rely on it.
5. **`BYPASS_AUTH` is dev-only.** It is refused when `NODE_ENV === 'production'` and prints a `WARN` at boot whenever it's on.
6. **Don't expand scope.** If a phase exposes a tempting cleanup ("oh, this `Sidebar` could really use a refactor"), file a follow-up note and resist. Ship the phase as written.
