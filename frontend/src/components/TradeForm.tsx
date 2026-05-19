import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Market,
  OrderSide,
  OrderType,
  Portfolio,
  TimeInForce,
} from '../lib/types';
import { askOrPrice, bidOrPrice } from '../lib/quote';
import type { PlaceOrderInput } from '../hooks/usePortfolio';
import { useMarketClock } from '../hooks/useMarketClock';
import { fmtMoney } from '../lib/format';

// ---- Domain enums local to this form -------------------------------------
// The four user-visible actions, in canonical screen order.
const SIDES: { v: OrderSide; lbl: string }[] = [
  { v: 'buy', lbl: 'Buy' },
  { v: 'sell', lbl: 'Sell' },
  { v: 'short', lbl: 'Sell Short' },
  { v: 'cover', lbl: 'Buy to Cover' },
];

// Verbs used in the submit button. UPPERCASE so they read like a confirmation.
const SIDE_VERB: Record<OrderSide, string> = {
  buy: 'BUY',
  sell: 'SELL',
  short: 'SELL SHORT',
  cover: 'BUY TO COVER',
};

// Per spec: only Market and Limit are exposed in the form.
const FORM_ORDER_TYPES: { v: OrderType; lbl: string }[] = [
  { v: 'market', lbl: 'Market' },
  { v: 'limit', lbl: 'Limit' },
];

// Per spec: only Day and GTC.
const TIFS: { v: TimeInForce; lbl: string; sub: string }[] = [
  { v: 'day', lbl: 'Day', sub: 'Today only' },
  { v: 'gtc', lbl: 'GTC', sub: "Good 'til canceled" },
];

type Unit = 'shares' | 'dollars';

export interface TradeFormProps {
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  placeOrder: (order: PlaceOrderInput) => void;
  initialSide?: OrderSide;
  /** Called after a successful submit. Hosts use it to close their container. */
  onDone?: () => void;
  /**
   * 'modal' = compact spacing for the watchlist trade modal.
   * 'panel' = a touch more breathing room for the right rail on the Trade page.
   */
  layout?: 'modal' | 'panel';
}

export function TradeForm({
  ticker,
  market,
  portfolio,
  placeOrder,
  initialSide = 'buy',
  onDone,
  layout = 'modal',
}: TradeFormProps) {
  const [side, setSide] = useState<OrderSide>(initialSide);
  const [unit, setUnit] = useState<Unit>('shares');
  const [type, setType] = useState<OrderType>('market');
  const [tif, setTif] = useState<TimeInForce>('day');
  const [shares, setShares] = useState<string>('10');
  const [dollars, setDollars] = useState<string>('1000');
  const [limitPrice, setLimitPrice] = useState<string>('');

  const { clock, loading: clockLoading } = useMarketClock();
  const marketIsOpen = clock?.isOpen === true;

  const m = market[ticker];
  const refPrice = m?.price ?? 0;

  // Sync `side` when the host swaps initialSide (e.g. user clicks a different
  // action button on the Trade page while the form is mounted). Mirrors the
  // App.tsx pattern of treating an external authority as the source of truth.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSide(initialSide);
  }, [initialSide]);

  // Seed the limit-price input the first time we have a quote for `ticker`,
  // and reseed whenever the user switches symbol or toggles into Limit mode.
  // Subsequent market ticks must NOT clobber what the user is typing.
  const seededRef = useRef<{ ticker: string; type: OrderType } | null>(null);
  useEffect(() => {
    if (!m) return;
    const seed = seededRef.current;
    if (seed && seed.ticker === ticker && seed.type === type) return;
    if (type === 'limit') {
      // Seed Limit price = latest market price (per spec).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLimitPrice(m.price.toFixed(2));
    }
    seededRef.current = { ticker, type };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, type, m?.price]);

  // ---- Derive effectiveQty from the unit + raw inputs -------------------
  // Dollars mode: ceil(dollars / refPrice). Mirrors the QuickFill "$ Total"
  // chip's old behavior — never round down because that surprises buyers
  // who said "I want to spend ~$1000."
  const dollarsNum = Number(dollars);
  const sharesFromDollars =
    Number.isFinite(dollarsNum) && dollarsNum > 0 && refPrice > 0
      ? Math.ceil(dollarsNum / refPrice)
      : 0;
  const effectiveQty =
    unit === 'shares' ? Math.max(0, Math.floor(+shares || 0)) : sharesFromDollars;

  // ---- Estimated price + cost --------------------------------------------
  const estimate = useMemo(() => {
    // Market orders fill at ask (long entry / cover) or bid (short entry / sell).
    // When bid/ask are missing, fall back to last trade price — this matches
    // backend fill logic in usePortfolio.placeOrder.
    const p =
      type === 'market'
        ? m
          ? side === 'buy' || side === 'cover'
            ? askOrPrice(m)
            : bidOrPrice(m)
          : 0
        : +limitPrice;
    const amount = (p || 0) * (effectiveQty || 0);
    return { price: p || 0, amount };
  }, [type, side, effectiveQty, limitPrice, m]);

  const positionLong = portfolio.positions.find(
    (p) => p.ticker === ticker && p.side === 'long',
  );
  const positionShort = portfolio.positions.find(
    (p) => p.ticker === ticker && p.side === 'short',
  );

  const buyingPower = portfolio.cash;
  // 'buy' opens long; 'cover' closes short — both move cash out, so both need
  // a buying-power check. 'sell' closes long, 'short' opens short — both move
  // cash in, so neither needs one. (Note: `isOpening` is a bit of a misnomer
  // because cover actually closes; here it means "consumes cash.")
  const isCashOut = side === 'buy' || side === 'cover';
  const affordable = isCashOut ? estimate.amount <= buyingPower : true;
  const marketBlockMarketOrder = type === 'market' && !marketIsOpen;

  // Closing-side guards. The backend silently no-ops the position update and
  // zeroes the cash delta when there's no matching position, but the order
  // still lands in history with status='filled' — confusing for the user.
  // Block the submit at the UI so we never send the request in the first
  // place. Same idea for over-closing (selling more than long, covering more
  // than short).
  const longQty = positionLong?.qty ?? 0;
  const shortQty = positionShort?.qty ?? 0;
  let closingBlock: string | null = null;
  if (side === 'sell') {
    if (longQty <= 0) {
      closingBlock = `You have no long position in ${ticker} to sell.`;
    } else if (effectiveQty > longQty) {
      closingBlock = `You only own ${longQty} share${longQty === 1 ? '' : 's'} of ${ticker}. Reduce the quantity or use Sell Short to open a short.`;
    }
  } else if (side === 'cover') {
    if (shortQty <= 0) {
      closingBlock = `You have no short position in ${ticker} to cover.`;
    } else if (effectiveQty > shortQty) {
      closingBlock = `You're only short ${shortQty} share${shortQty === 1 ? '' : 's'} of ${ticker}. Reduce the quantity to cover what you owe.`;
    }
  }

  const submit = () => {
    if (effectiveQty <= 0) return;
    if (!affordable || marketBlockMarketOrder || closingBlock) return;
    const order: PlaceOrderInput = {
      ticker,
      side,
      type,
      qty: effectiveQty,
      tif,
    };
    if (type === 'limit') order.limitPrice = +limitPrice;
    placeOrder(order);
    onDone?.();
  };

  const sideColor: 'buy' | 'sell' = isCashOut ? 'buy' : 'sell';
  const sideVerb = SIDE_VERB[side];

  if (!m) {
    return (
      <div
        className="trade-form-empty"
        style={{
          padding: 24,
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 13,
        }}
      >
        No live quote for {ticker} yet. The form unlocks as soon as data arrives.
      </div>
    );
  }

  return (
    <div className={`trade-form trade-form-${layout}`}>
      {/* Price strip — header context, not an input row */}
      <div className="trade-form-quote">
        <div>
          <div className="trade-form-quote-ticker">{ticker}</div>
          <div className={`mono tnum trade-form-quote-price`}>
            ${m.price.toFixed(2)}
          </div>
        </div>
        <div className="trade-form-quote-ba">
          <div>
            <span className="trade-form-quote-ba-label">Bid</span>
            <span className="mono tnum">
              {m.bid != null ? m.bid.toFixed(2) : '—'}
            </span>
          </div>
          <div>
            <span className="trade-form-quote-ba-label">Ask</span>
            <span className="mono tnum">
              {m.ask != null ? m.ask.toFixed(2) : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* Action — Buy / Sell / Sell Short / Buy to Cover */}
      <FormRow label="Action">
        <div className="segmented side-toggle trade-form-action">
          {SIDES.map((s) => (
            <button
              key={s.v}
              type="button"
              className={`${side === s.v ? 'active ' + sideColor : ''}`.trim()}
              onClick={() => setSide(s.v)}
            >
              {s.lbl}
            </button>
          ))}
        </div>
      </FormRow>

      {/* Unit — Shares vs Dollars */}
      <FormRow label="Unit">
        <div className="trade-form-unit">
          <div className="segmented trade-form-unit-toggle">
            <button
              type="button"
              className={unit === 'shares' ? 'active' : ''}
              onClick={() => setUnit('shares')}
            >
              Shares
            </button>
            <button
              type="button"
              className={unit === 'dollars' ? 'active' : ''}
              onClick={() => setUnit('dollars')}
            >
              Dollars
            </button>
          </div>
          <div className="input-affix trade-form-unit-input">
            {unit === 'shares' ? (
              <input
                key="shares"
                className="input mono"
                type="number"
                min="1"
                step="1"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
              />
            ) : (
              <input
                key="dollars"
                className="input mono"
                type="number"
                min="1"
                step="1"
                value={dollars}
                onChange={(e) => setDollars(e.target.value)}
              />
            )}
            <span className="affix">{unit === 'shares' ? 'SHARES' : 'USD'}</span>
          </div>
        </div>
        {unit === 'dollars' && (
          <div className="trade-form-hint">
            {sharesFromDollars > 0
              ? `≈ ${sharesFromDollars} share${sharesFromDollars === 1 ? '' : 's'} @ $${refPrice.toFixed(2)} (rounded up)`
              : 'Enter a positive amount.'}
          </div>
        )}
      </FormRow>

      {/* Order Type — Market / Limit */}
      <FormRow label="Order Type">
        <div className="segmented trade-form-type">
          {FORM_ORDER_TYPES.map((o) => (
            <button
              key={o.v}
              type="button"
              className={type === o.v ? 'active' : ''}
              onClick={() => setType(o.v)}
            >
              {o.lbl}
            </button>
          ))}
        </div>
        <div
          className={`trade-form-limit-slot ${type === 'limit' ? 'open' : ''}`}
          aria-hidden={type !== 'limit'}
        >
          <div className="input-affix">
            <input
              className="input mono"
              type="number"
              step="0.01"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder="Limit price"
            />
            <span className="affix">USD</span>
          </div>
          <div className="trade-form-hint">
            Order fills only at this price or better.
          </div>
        </div>
      </FormRow>

      {/* Timing — Day / GTC */}
      <FormRow label="Timing">
        <div className="segmented trade-form-tif">
          {TIFS.map((t) => (
            <button
              key={t.v}
              type="button"
              className={tif === t.v ? 'active' : ''}
              onClick={() => setTif(t.v)}
              title={t.sub}
            >
              <span>{t.lbl}</span>
              <span className="trade-form-tif-sub">{t.sub}</span>
            </button>
          ))}
        </div>
      </FormRow>

      {/* Existing position summary — purely informational */}
      {(positionLong || positionShort) && (
        <div className="trade-form-position">
          {positionLong && (
            <div>
              <span className="pill long">LONG</span>{' '}
              <span className="mono tnum">{positionLong.qty}</span> @{' '}
              <span className="mono tnum">
                ${positionLong.avgPrice.toFixed(2)}
              </span>
            </div>
          )}
          {positionShort && (
            <div>
              <span className="pill short">SHORT</span>{' '}
              <span className="mono tnum">{positionShort.qty}</span> @{' '}
              <span className="mono tnum">
                ${positionShort.avgPrice.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Estimate strip — pre-trade math, mirrored from the old ticket */}
      <div className="trade-form-estimate">
        <div>
          <span>Est. price</span>
          <span className="mono tnum">${estimate.price.toFixed(2)}</span>
        </div>
        <div className="strong">
          <span>Est. {isCashOut ? 'cost' : 'proceeds'}</span>
          <span className="mono tnum">${estimate.amount.toFixed(2)}</span>
        </div>
        <div className="muted">
          <span>Buying power</span>
          <span className="mono tnum">{fmtMoney(buyingPower)}</span>
        </div>
      </div>

      {closingBlock && (
        <div className="trade-form-warn">{closingBlock}</div>
      )}

      {!affordable && (
        <div className="trade-form-warn">
          Insufficient buying power for this order.
        </div>
      )}

      {marketBlockMarketOrder && (
        <div className="trade-form-warn">
          {clockLoading
            ? 'Checking market status…'
            : clock
              ? `Market closed — opens ${formatNextOpen(clock.nextOpen)}. Switch to Limit to queue this order.`
              : 'Market status unavailable. Switch to Limit to queue this order.'}
        </div>
      )}

      <button
        type="button"
        className={`btn ${sideColor} trade-form-submit`}
        disabled={
          effectiveQty <= 0 ||
          !affordable ||
          marketBlockMarketOrder ||
          closingBlock !== null
        }
        onClick={submit}
      >
        {sideVerb} {effectiveQty || 0} {ticker}
        {type === 'limit' ? ' · Limit' : ''}
      </button>
    </div>
  );
}

function FormRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="trade-form-row">
      <div className="trade-form-row-label">{label}</div>
      <div className="trade-form-row-body">{children}</div>
    </div>
  );
}

// Format the /clock nextOpen epoch-ms in America/New_York wall clock so the
// user sees "Mon 9:30 AM ET" instead of a raw ISO string. Day label is
// omitted when nextOpen is later today.
function formatNextOpen(nextOpenEpochMs: number): string {
  const target = new Date(nextOpenEpochMs);
  const now = new Date();
  const dayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  });
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const sameDay = dateFmt.format(target) === dateFmt.format(now);
  return sameDay
    ? `${timeFmt.format(target)} ET`
    : `${dayFmt.format(target)} ${timeFmt.format(target)} ET`;
}
