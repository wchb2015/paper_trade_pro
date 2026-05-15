-- =============================================================================
-- paper_trade_pro — schema bootstrap
--
-- Idempotent. Safe to run multiple times against the same database.
-- Targets PostgreSQL 18+. Uses uuidv7() (built-in since PG 18) for primary keys
-- so IDs are time-sortable without an extension. Uses CREATE OR REPLACE
-- TRIGGER (PG 14+) for the updated_at auto-bumper.
--
-- Enum value-space validation lives in application code only — see the
-- runtime guards (isOrderSide, isOrderType, isTimeInForce, isAlertCondition,
-- isConditionalOp) in shared/src/contracts/portfolio.ts. PortfolioStore.ts
-- enforces them on every read AND write, so the DB does not duplicate the
-- enum lists. Cross-field structural CHECKs (e.g. "limit_price required when
-- type='limit'") are kept because they encode business invariants, not enum
-- membership.
--
-- Apply via:
--   psql "$DATABASE_URL" -f backend/scripts/init-db.sql
--   npm run --prefix backend db:init        # tsx scripts/initDb.ts
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS paper_trade_pro;

-- All tables in this file live in this schema.
SET LOCAL search_path = paper_trade_pro, public;

-- -----------------------------------------------------------------------------
-- updated_at auto-bumper. Attached to every table below so app code never has
-- to remember to set it. Row's `updated_at` is forced to now() on every
-- UPDATE, regardless of whether the caller provided a value.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION paper_trade_pro.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- accounts — one row per user. Self-provisioned by PortfolioStore.ensureAccount
-- on first portfolio read.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.accounts (
  user_id       UUID         PRIMARY KEY,
  cash          NUMERIC(14,2) NOT NULL,
  initial_cash  NUMERIC(14,2) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT accounts_initial_cash_pos CHECK (initial_cash > 0)
);
ALTER TABLE paper_trade_pro.accounts
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE paper_trade_pro.accounts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.accounts
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

-- -----------------------------------------------------------------------------
-- orders — working + terminal orders all live here.
--   status='pending'      : non-market order awaiting trigger
--   status='pending_fill' : market order in-flight (set just before applyFill)
--   status='filled'       : terminal, has filled_at + fill_price
--   status='cancelled'    : terminal, has cancelled_at
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.orders (
  id            UUID         PRIMARY KEY DEFAULT uuidv7(),
  user_id       UUID         NOT NULL,
  ticker        TEXT         NOT NULL,
  side          TEXT         NOT NULL,
  type          TEXT         NOT NULL,
  qty           INTEGER      NOT NULL,
  tif           TEXT         NOT NULL,
  status        TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  limit_price   NUMERIC(14,4),
  stop_price    NUMERIC(14,4),
  trail_pct     NUMERIC(8,4),
  peak          NUMERIC(14,4),
  cond_ticker   TEXT,
  cond_op       TEXT,
  cond_price    NUMERIC(14,4),
  inner_type    TEXT,
  filled_at     TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  fill_price    NUMERIC(14,4),

  CONSTRAINT orders_qty_pos CHECK (qty > 0),
  CONSTRAINT orders_limit_required
    CHECK (
      type NOT IN ('limit','stop_limit')
      OR limit_price IS NOT NULL
    ),
  CONSTRAINT orders_stop_required
    CHECK (
      type NOT IN ('stop','stop_limit')
      OR stop_price IS NOT NULL
    ),
  CONSTRAINT orders_trail_required
    CHECK (
      type <> 'trailing_stop'
      OR trail_pct IS NOT NULL
    ),
  CONSTRAINT orders_cond_required
    CHECK (
      type <> 'conditional'
      OR (cond_ticker IS NOT NULL AND cond_op IS NOT NULL AND cond_price IS NOT NULL)
    ),
  CONSTRAINT orders_filled_consistency
    CHECK ((status = 'filled') = (filled_at IS NOT NULL AND fill_price IS NOT NULL)),
  CONSTRAINT orders_cancelled_consistency
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
ALTER TABLE paper_trade_pro.orders
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE paper_trade_pro.orders
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Drop legacy enum value-space CHECKs if they exist from a prior DDL revision.
ALTER TABLE paper_trade_pro.orders DROP CONSTRAINT IF EXISTS orders_side_valid;
ALTER TABLE paper_trade_pro.orders DROP CONSTRAINT IF EXISTS orders_type_valid;
ALTER TABLE paper_trade_pro.orders DROP CONSTRAINT IF EXISTS orders_tif_valid;
ALTER TABLE paper_trade_pro.orders DROP CONSTRAINT IF EXISTS orders_status_valid;
ALTER TABLE paper_trade_pro.orders DROP CONSTRAINT IF EXISTS orders_cond_op_valid;
ALTER TABLE paper_trade_pro.orders DROP CONSTRAINT IF EXISTS orders_inner_type_valid;

CREATE OR REPLACE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.orders
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

-- Hot path: working orders for a user. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS orders_user_working_idx
  ON paper_trade_pro.orders (user_id, created_at DESC)
  WHERE status IN ('pending','pending_fill');

-- History query: filled/cancelled, ordered by terminal timestamp.
CREATE INDEX IF NOT EXISTS orders_user_history_idx
  ON paper_trade_pro.orders (user_id, COALESCE(filled_at, cancelled_at, created_at) DESC)
  WHERE status IN ('filled','cancelled');

-- -----------------------------------------------------------------------------
-- positions — one row per (user, ticker, side). Merge math in
-- PortfolioStore.applyFill relies on the unique constraint.
--
-- `opened_at` is a domain field exposed on the wire as Position.openedAt and
-- is independent of the row-lifecycle `created_at` / `updated_at`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.positions (
  id          UUID         PRIMARY KEY DEFAULT uuidv7(),
  user_id     UUID         NOT NULL,
  ticker      TEXT         NOT NULL,
  side        TEXT         NOT NULL,
  qty         INTEGER      NOT NULL,
  avg_price   NUMERIC(14,4) NOT NULL,
  opened_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT positions_qty_pos CHECK (qty > 0),
  CONSTRAINT positions_avg_pos CHECK (avg_price > 0),
  CONSTRAINT positions_unique_per_book UNIQUE (user_id, ticker, side)
);
ALTER TABLE paper_trade_pro.positions
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE paper_trade_pro.positions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE paper_trade_pro.positions DROP CONSTRAINT IF EXISTS positions_side_valid;

CREATE OR REPLACE TRIGGER positions_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.positions
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

CREATE INDEX IF NOT EXISTS positions_user_opened_idx
  ON paper_trade_pro.positions (user_id, opened_at DESC);

-- -----------------------------------------------------------------------------
-- alerts — price alerts. `triggered_at` is set once and stays set; toggling
-- `active` only enables/disables future evaluation.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.alerts (
  id              UUID         PRIMARY KEY DEFAULT uuidv7(),
  user_id         UUID         NOT NULL,
  ticker          TEXT         NOT NULL,
  condition       TEXT         NOT NULL,
  price           NUMERIC(14,4) NOT NULL,
  active          BOOLEAN      NOT NULL DEFAULT TRUE,
  note            TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  triggered_at    TIMESTAMPTZ,
  triggered_price NUMERIC(14,4),

  CONSTRAINT alerts_price_pos CHECK (price > 0),
  CONSTRAINT alerts_triggered_consistency
    CHECK ((triggered_at IS NULL) = (triggered_price IS NULL))
);
ALTER TABLE paper_trade_pro.alerts
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE paper_trade_pro.alerts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE paper_trade_pro.alerts DROP CONSTRAINT IF EXISTS alerts_condition_valid;

CREATE OR REPLACE TRIGGER alerts_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.alerts
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

CREATE INDEX IF NOT EXISTS alerts_user_created_idx
  ON paper_trade_pro.alerts (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- watchlist — a thin (user, ticker) list. PK is the natural key.
-- `added_at` is the user-meaningful timestamp used for stable list ordering;
-- `created_at` / `updated_at` are row-lifecycle for parity with other tables.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.watchlist (
  user_id     UUID        NOT NULL,
  ticker      TEXT        NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticker)
);
ALTER TABLE paper_trade_pro.watchlist
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE paper_trade_pro.watchlist
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE TRIGGER watchlist_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.watchlist
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

CREATE INDEX IF NOT EXISTS watchlist_user_added_idx
  ON paper_trade_pro.watchlist (user_id, added_at ASC);
