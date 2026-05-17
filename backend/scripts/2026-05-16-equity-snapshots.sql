-- =============================================================================
-- Migration 2026-05-16 — equity_snapshots
--
-- Stores per-user portfolio-value samples used by the Dashboard's
-- "Portfolio value" chart (range buttons 1M / 3M / YTD / ALL). Snapshots are
-- written by:
--   (a) EquitySnapshotter (in-process scheduled job, default every 60s,
--       prices positions against the live QuoteCache)
--   (b) The portfolio routes after every successful fill / reset, by
--       invoking EquitySnapshotter.snapshotUser(userId) — same pricing
--       path as (a). resetFunds first DELETEs all prior rows for the user.
--
-- Apply via:
--   psql "$DATABASE_URL" -f backend/scripts/2026-05-16-equity-snapshots.sql
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS paper_trade_pro;
SET LOCAL search_path = paper_trade_pro, public;

CREATE TABLE IF NOT EXISTS paper_trade_pro.equity_snapshots (
  id            UUID         PRIMARY KEY DEFAULT uuidv7(),
  user_id       UUID         NOT NULL,
  taken_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  equity        NUMERIC(16,2) NOT NULL,
  cash          NUMERIC(14,2) NOT NULL,
  market_value  NUMERIC(16,2) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT equity_snapshots_equity_finite CHECK (equity = equity),
  CONSTRAINT equity_snapshots_cash_finite   CHECK (cash = cash),
  CONSTRAINT equity_snapshots_mv_nonneg     CHECK (market_value >= 0)
);

CREATE OR REPLACE TRIGGER equity_snapshots_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.equity_snapshots
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

-- Hot path: range queries scan by (user_id, taken_at).
CREATE INDEX IF NOT EXISTS equity_snapshots_user_taken_idx
  ON paper_trade_pro.equity_snapshots (user_id, taken_at ASC);
