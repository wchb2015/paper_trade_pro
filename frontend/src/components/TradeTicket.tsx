import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
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
import { replayFifo, type Lot } from '../lib/pnl';
import { fmtMoney, fmtPct } from '../lib/format';

export const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'stop', label: 'Stop Loss' },
  { value: 'stop_limit', label: 'Stop Limit' },
  { value: 'trailing_stop', label: 'Trailing Stop' },
  { value: 'conditional', label: 'Conditional' },
];

interface TradeTicketProps {
  open: boolean;
  onClose: () => void;
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  placeOrder: (order: PlaceOrderInput) => void;
  initialSide?: OrderSide;
}

type Mode = 'long' | 'short';

export function TradeTicket({
  open,
  onClose,
  ticker,
  market,
  portfolio,
  placeOrder,
  initialSide = 'buy',
}: TradeTicketProps) {
  const [side, setSide] = useState<OrderSide>(initialSide);
  const [type, setType] = useState<OrderType>('market');
  const [qty, setQty] = useState<number | string>(10);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budget, setBudget] = useState<string>('30000');
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [stopPrice, setStopPrice] = useState<string>('');
  const [trailPct, setTrailPct] = useState<number | string>(2);
  const [tif, setTif] = useState<TimeInForce>('day');
  const [condTicker, setCondTicker] = useState<string>(ticker || 'AAPL');
  const [condOp, setCondOp] = useState<'>=' | '<='>('>=');
  const [condPrice, setCondPrice] = useState<string>('');
  const [mode, setMode] = useState<Mode>(
    initialSide === 'short' || initialSide === 'cover' ? 'short' : 'long',
  );
  // Lot picker — Set<openOrderId>. When non-empty, qty is derived from the
  // sum of selected lots and the manual Quantity input is disabled.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedLots, setSelectedLots] = useState<Set<string>>(new Set());

  // Market hours — drives the "Market closed" banner + disables the submit
  // button when type === 'market'. Limit/stop/trailing/conditional orders
  // are still allowed (they're queued and only fill when triggered).
  const { clock, loading: clockLoading } = useMarketClock();
  // Treat unknown (first-load or fetch error) as closed for market orders so
  // we never let one through optimistically. Limit/stop/etc. are unaffected.
  const marketIsOpen = clock?.isOpen === true;
  const marketBlockMarketOrder = type === 'market' && !marketIsOpen;

  const m = market[ticker];
  const refPrice = m?.price ?? 0;

  // Seed price inputs only on the first tick where (open && m) becomes true
  // for a given ticker. Subsequent market ticks must NOT overwrite what the
  // user is typing.
  const seededRef = useRef<{ open: boolean; ticker: string } | null>(null);
  useEffect(() => {
    if (!open) {
      seededRef.current = null;
      return;
    }
    if (!m) return;
    const seeded = seededRef.current;
    if (seeded && seeded.open && seeded.ticker === ticker) return;
    setLimitPrice(m.price.toFixed(2));
    setStopPrice(
      (m.price * (side === 'buy' ? 1.02 : 0.98)).toFixed(2),
    );
    setCondTicker(ticker);
    setCondPrice(m.price.toFixed(2));
    seededRef.current = { open: true, ticker };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ticker, m?.price]);

  useEffect(() => {
    setSide(initialSide);
    setMode(
      initialSide === 'short' || initialSide === 'cover' ? 'short' : 'long',
    );
    // Reset $-Total popover state every modal open per spec (no persistence).
    if (open) {
      setBudget('30000');
      setBudgetOpen(false);
      setPickerOpen(false);
      setSelectedLots(new Set());
    }
  }, [initialSide, open]);

  const sides: { v: OrderSide; lbl: string }[] =
    mode === 'long'
      ? [
          { v: 'buy', lbl: 'Buy' },
          { v: 'sell', lbl: 'Sell' },
        ]
      : [
          { v: 'short', lbl: 'Short' },
          { v: 'cover', lbl: 'Cover' },
        ];

  useEffect(() => {
    if (mode === 'long' && (side === 'short' || side === 'cover'))
      setSide('buy');
    if (mode === 'short' && (side === 'buy' || side === 'sell'))
      setSide('short');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const positionLong = portfolio.positions.find(
    (p) => p.ticker === ticker && p.side === 'long',
  );
  const positionShort = portfolio.positions.find(
    (p) => p.ticker === ticker && p.side === 'short',
  );

  // Open lots for the active ticker, derived from FIFO replay over the
  // entire filled history. Drives the "Advanced: pick lots" picker.
  const tickerLots = useMemo(() => {
    const fifo = replayFifo(portfolio.history, portfolio.positions);
    const q = fifo.openLots.get(ticker);
    if (!q) return { long: [] as Lot[], short: [] as Lot[] };
    return {
      long: q.long.filter((l) => l.qty > 0),
      short: q.short.filter((l) => l.qty > 0),
    };
  }, [portfolio.history, portfolio.positions, ticker]);

  // Which lot list is relevant for the current side. Picker is hidden
  // unless we have ≥2 lots and the user is closing (sell or cover) and
  // type is not conditional (multi-lot conditional orders are out of scope).
  const closingLots: Lot[] =
    side === 'sell'
      ? tickerLots.long
      : side === 'cover'
        ? tickerLots.short
        : [];
  const showPicker =
    (side === 'sell' || side === 'cover') &&
    closingLots.length >= 2 &&
    type !== 'conditional';

  // When lot picker is in use, qty is derived. Otherwise read the manual input.
  const selectedLotsList = closingLots.filter((l) =>
    selectedLots.has(l.openOrderId),
  );
  const lotMode = pickerOpen && selectedLotsList.length > 0;
  const effectiveQty = lotMode
    ? selectedLotsList.reduce((sum, l) => sum + l.qty, 0)
    : +qty;

  const estimate = useMemo(() => {
    // Fall back to last trade price when bid/ask isn't published — replay files
    // are trades-only, and the live WS handler currently emits null bid/ask too.
    // Mirrors the fill-pricing rule in usePortfolio.placeOrder.
    const p =
      type === 'market'
        ? m
          ? side === 'buy' || side === 'cover'
            ? askOrPrice(m)
            : bidOrPrice(m)
          : 0
        : type === 'limit'
          ? +limitPrice
          : type === 'stop'
            ? refPrice
            : type === 'stop_limit'
              ? +limitPrice
              : refPrice;
    const amount = (p || 0) * (effectiveQty || 0);
    return { price: p || 0, amount };
  }, [type, side, effectiveQty, limitPrice, refPrice, m]);

  const buyingPower = portfolio.cash;
  const affordable =
    side === 'buy' || side === 'cover'
      ? estimate.amount <= buyingPower
      : true;

  // Build the shared (non-qty) fields once; lot-mode and single-order paths
  // both use them.
  const buildOrderShape = (
    qtyForOrder: number,
  ): PlaceOrderInput => {
    const order: PlaceOrderInput = {
      ticker,
      side,
      type,
      qty: qtyForOrder,
      tif,
    };
    if (type === 'limit' || type === 'stop_limit')
      order.limitPrice = +limitPrice;
    if (type === 'stop' || type === 'stop_limit')
      order.stopPrice = +stopPrice;
    if (type === 'trailing_stop') order.trailPct = +trailPct;
    if (type === 'conditional') {
      order.condTrigger = {
        ticker: condTicker,
        op: condOp,
        price: +condPrice,
      };
      order.innerType = 'market';
    }
    return order;
  };

  const submit = () => {
    if (lotMode) {
      // Place one order per selected lot. They all use the same fill price
      // (single tick) so total proceeds match a combined sell; the only
      // difference is each lot becomes its own row in Orders > Filled and
      // its P&L can be matched 1:1 to the closing order id.
      for (const lot of selectedLotsList) {
        if (lot.qty <= 0) continue;
        placeOrder(buildOrderShape(lot.qty));
      }
      onClose();
      return;
    }
    const numQty = +qty;
    if (!numQty || numQty <= 0) return;
    placeOrder(buildOrderShape(numQty));
    onClose();
  };

  if (!open || !m) return null;

  const sideColor: 'buy' | 'sell' =
    side === 'buy' || side === 'cover' ? 'buy' : 'sell';

  const typeLabel = ORDER_TYPES.find((o) => o.value === type)?.label ?? 'Order';

  return (
    <Modal open={open} onClose={onClose} title={`Trade · ${ticker}`} size="md">
      {/* Current price strip */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'baseline',
          marginBottom: 14,
          paddingBottom: 12,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="mono tnum"
            style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}
          >
            ${m.price.toFixed(2)}
          </div>
        </div>
        <div
          style={{
            textAlign: 'right',
            fontSize: 12,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <div className="mono tnum" style={{ color: 'var(--text-muted)' }}>
            Bid{' '}
            <span style={{ color: 'var(--text)' }}>
              {m.bid != null ? m.bid.toFixed(2) : '—'}
            </span>
          </div>
          <div
            className="mono tnum"
            style={{ color: 'var(--text-muted)', marginTop: 2 }}
          >
            Ask{' '}
            <span style={{ color: 'var(--text)' }}>
              {m.ask != null ? m.ask.toFixed(2) : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* long/short mode */}
      <div
        className="segmented"
        style={{ display: 'flex', marginBottom: 12, width: '100%' }}
      >
        <button
          className={mode === 'long' ? 'active' : ''}
          style={{ flex: 1 }}
          onClick={() => setMode('long')}
        >
          Long
        </button>
        <button
          className={mode === 'short' ? 'active' : ''}
          style={{ flex: 1 }}
          onClick={() => setMode('short')}
        >
          Short
        </button>
      </div>

      {/* side toggle */}
      <div
        className="segmented side-toggle"
        style={{ display: 'flex', marginBottom: 14, width: '100%' }}
      >
        {sides.map((s) => (
          <button
            key={s.v}
            className={`${side === s.v ? 'active ' + sideColor : ''}`.trim()}
            style={{ flex: 1 }}
            onClick={() => setSide(s.v)}
          >
            {s.lbl}
          </button>
        ))}
      </div>

      {/* order type */}
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="label">Order Type</label>
        <select
          className="select"
          value={type}
          onChange={(e) => setType(e.target.value as OrderType)}
        >
          {ORDER_TYPES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* quantity */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div className="field">
          <label className="label">
            Quantity
            {lotMode && (
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>
                {selectedLotsList.length} lot{selectedLotsList.length === 1 ? '' : 's'} → {effectiveQty}
              </span>
            )}
          </label>
          <input
            className="input mono"
            type="number"
            min="1"
            step="1"
            value={lotMode ? effectiveQty : qty}
            onChange={(e) => setQty(e.target.value)}
            disabled={lotMode}
            title={lotMode ? 'Quantity comes from selected lots; uncheck them to edit manually.' : undefined}
          />
          <QuickFillChips
            side={side}
            refPrice={refPrice}
            positionLong={positionLong}
            positionShort={positionShort}
            budgetOpen={budgetOpen}
            setBudgetOpen={setBudgetOpen}
            budget={budget}
            setBudget={setBudget}
            setQty={setQty}
          />
        </div>
        <div className="field">
          <label className="label">Time in Force</label>
          <select
            className="select"
            value={tif}
            onChange={(e) => setTif(e.target.value as TimeInForce)}
          >
            <option value="day">Day</option>
            <option value="gtc">Good 'til Cancel</option>
            <option value="ioc">Immediate or Cancel</option>
          </select>
        </div>
      </div>

      {(type === 'limit' || type === 'stop_limit') && (
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="label">Limit Price</label>
          <div className="input-affix">
            <input
              className="input mono"
              type="number"
              step="0.01"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
            <span className="affix">USD</span>
          </div>
        </div>
      )}

      {(type === 'stop' || type === 'stop_limit') && (
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="label">Stop Price</label>
          <div className="input-affix">
            <input
              className="input mono"
              type="number"
              step="0.01"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
            />
            <span className="affix">USD</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Triggers when price{' '}
            {side === 'sell' || side === 'short'
              ? 'falls to'
              : 'rises to'}{' '}
            this level
          </div>
        </div>
      )}

      {type === 'trailing_stop' && (
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="label">Trail Percent</label>
          <div className="input-affix">
            <input
              className="input mono"
              type="number"
              step="0.1"
              min="0.1"
              max="50"
              value={trailPct}
              onChange={(e) => setTrailPct(e.target.value)}
            />
            <span className="affix">%</span>
          </div>
        </div>
      )}

      {type === 'conditional' && (
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            background: 'var(--bg-muted)',
            borderRadius: 8,
          }}
        >
          <div className="label" style={{ marginBottom: 8 }}>
            If-Then Trigger
          </div>
          <div className="input-group" style={{ marginBottom: 8 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              placeholder="Ticker"
              value={condTicker}
              onChange={(e) =>
                setCondTicker(e.target.value.toUpperCase())
              }
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <select
              className="select"
              style={{ width: 72 }}
              value={condOp}
              onChange={(e) => setCondOp(e.target.value as '>=' | '<=')}
            >
              <option value=">=">≥</option>
              <option value="<=">≤</option>
            </select>
            <input
              className="input mono"
              style={{ width: 110 }}
              type="number"
              step="0.01"
              value={condPrice}
              onChange={(e) => setCondPrice(e.target.value)}
            />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Then {side.toUpperCase()} {qty} {ticker} at market
          </div>
        </div>
      )}

      {(positionLong || positionShort) && (
        <div
          style={{
            padding: 10,
            background: 'var(--bg-muted)',
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 12,
            display: 'flex',
            gap: 16,
          }}
        >
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

      {showPicker && (
        <div className="lot-picker">
          <button
            type="button"
            className="lot-picker-toggle"
            onClick={() => setPickerOpen((v) => !v)}
          >
            <span>Advanced: pick lots ({closingLots.length} open)</span>
            <span style={{ marginLeft: 'auto', fontSize: 11 }}>
              {pickerOpen ? '▴' : '▾'}
            </span>
          </button>
          {pickerOpen && (
            <div className="lot-picker-list">
              {closingLots.map((lot) => {
                // P&L if we sold this whole lot at the current ref price.
                const livePerShare =
                  side === 'sell'
                    ? refPrice - lot.costPerShare
                    : lot.costPerShare - refPrice;
                const liveAbs = livePerShare * lot.qty;
                const liveCost = lot.costPerShare * lot.qty;
                const livePct = liveCost > 0 ? (liveAbs / liveCost) * 100 : 0;
                const checked = selectedLots.has(lot.openOrderId);
                const ageDays = Math.max(
                  0,
                  Math.floor((Date.now() - lot.openedAt) / 86_400_000),
                );
                const ageLabel =
                  ageDays === 0
                    ? 'today'
                    : ageDays === 1
                      ? '1d ago'
                      : `${ageDays}d ago`;
                const pnlColor =
                  liveAbs > 0
                    ? 'var(--up)'
                    : liveAbs < 0
                      ? 'var(--down)'
                      : 'var(--text-muted)';
                return (
                  <label key={lot.openOrderId} className="lot-row">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setSelectedLots((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(lot.openOrderId);
                          else next.delete(lot.openOrderId);
                          return next;
                        });
                      }}
                    />
                    <span className="mono tnum">{lot.qty}</span>
                    <span className="lot-row-meta">
                      @ ${lot.costPerShare.toFixed(2)} · {ageLabel}
                    </span>
                    <span
                      className="mono tnum lot-row-pnl"
                      style={{ color: pnlColor }}
                    >
                      {fmtMoney(liveAbs, { signed: true })}{' '}
                      <span style={{ fontSize: 10.5 }}>{fmtPct(livePct)}</span>
                    </span>
                  </label>
                );
              })}
              {selectedLotsList.length > 0 && (
                <div className="lot-picker-summary">
                  Selected: <b>{selectedLotsList.length}</b> lot
                  {selectedLotsList.length === 1 ? '' : 's'}, total{' '}
                  <b>{effectiveQty}</b> share
                  {effectiveQty === 1 ? '' : 's'} → {selectedLotsList.length}{' '}
                  separate order{selectedLotsList.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          padding: '14px 14px',
          background: 'var(--bg-muted)',
          borderRadius: 8,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            fontSize: 12,
            marginBottom: 6,
          }}
        >
          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            Est. price
          </span>
          <span className="mono tnum" style={{ whiteSpace: 'nowrap' }}>
            ${estimate.price.toFixed(2)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <span style={{ whiteSpace: 'nowrap' }}>
            Est. {side === 'buy' || side === 'cover' ? 'cost' : 'proceeds'}
          </span>
          <span className="mono tnum" style={{ whiteSpace: 'nowrap' }}>
            ${estimate.amount.toFixed(2)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            fontSize: 11.5,
            marginTop: 8,
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ whiteSpace: 'nowrap' }}>Buying power</span>
          <span className="mono tnum" style={{ whiteSpace: 'nowrap' }}>
            $
            {buyingPower.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>
      </div>

      {!affordable && (
        <div
          style={{
            padding: 10,
            background: 'var(--down-bg)',
            color: 'var(--down)',
            borderRadius: 6,
            fontSize: 12,
            marginBottom: 12,
          }}
        >
          Insufficient buying power for this order.
        </div>
      )}

      {marketBlockMarketOrder && (
        <div
          style={{
            padding: 10,
            background: 'var(--down-bg)',
            color: 'var(--down)',
            borderRadius: 6,
            fontSize: 12,
            marginBottom: 12,
          }}
        >
          {clockLoading
            ? 'Checking market status…'
            : clock
              ? `Market closed — opens ${formatNextOpen(clock.nextOpen)}. Switch to a limit, stop, or conditional order to queue this trade.`
              : 'Market status unavailable — try again in a moment, or switch to a limit/stop order.'}
        </div>
      )}

      <button
        className={`btn ${sideColor}`}
        style={{ width: '100%', padding: '12px', fontSize: 14, fontWeight: 600 }}
        disabled={
          !affordable || effectiveQty <= 0 || marketBlockMarketOrder
        }
        onClick={submit}
      >
        {lotMode && selectedLotsList.length >= 2
          ? `${side.toUpperCase()} ${selectedLotsList.length} LOTS · ${effectiveQty} ${ticker}`
          : `${side.toUpperCase()} ${effectiveQty || qty} ${ticker}`}
        {type !== 'market' ? ` · ${typeLabel}` : ''}
      </button>
    </Modal>
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

interface QuickFillChipsProps {
  side: OrderSide;
  refPrice: number;
  positionLong: Portfolio['positions'][number] | undefined;
  positionShort: Portfolio['positions'][number] | undefined;
  budgetOpen: boolean;
  setBudgetOpen: (v: boolean) => void;
  budget: string;
  setBudget: (v: string) => void;
  setQty: (v: number) => void;
}

function QuickFillChips({
  side,
  refPrice,
  positionLong,
  positionShort,
  budgetOpen,
  setBudgetOpen,
  budget,
  setBudget,
  setQty,
}: QuickFillChipsProps) {
  // For sell/cover: show closing-position shortcuts when there's a matching
  // position. We pick the position based on side rather than mode to avoid
  // surprises when the user changes mode after opening from a position card.
  const closingPos =
    side === 'sell'
      ? positionLong
      : side === 'cover'
        ? positionShort
        : undefined;
  // For buy: cash budget. For cover: budget makes less sense (closing a short
  // is qty-driven), so we hide it on cover. Spec said "buy" — keep it that way.
  const showBudget = side === 'buy' && refPrice > 0;

  // Compute share count from budget. Always round up: int(b/p) + 1 unless
  // b/p is a whole number (then exactly b/p). Math.ceil handles both.
  const budgetNum = Number(budget);
  const sharesFromBudget =
    Number.isFinite(budgetNum) && budgetNum > 0 && refPrice > 0
      ? Math.ceil(budgetNum / refPrice)
      : 0;
  const projectedCost = sharesFromBudget * refPrice;

  const showCloseChips = closingPos && closingPos.qty > 0;

  if (!showCloseChips && !showBudget) return null;

  return (
    <div className="qf-row">
      {showCloseChips && closingPos && (
        <>
          <button
            type="button"
            className="qf-chip"
            onClick={() => setQty(closingPos.qty)}
            title={`Set quantity to your full ${closingPos.side} position`}
          >
            {side === 'sell' ? 'Sell all' : 'Cover all'} ({closingPos.qty})
          </button>
          {closingPos.qty >= 2 && (
            <button
              type="button"
              className="qf-chip qf-chip-secondary"
              onClick={() =>
                setQty(Math.max(1, Math.floor(closingPos.qty / 2)))
              }
              title="Half of your position"
            >
              ½
            </button>
          )}
          {closingPos.qty >= 4 && (
            <button
              type="button"
              className="qf-chip qf-chip-secondary"
              onClick={() =>
                setQty(Math.max(1, Math.floor(closingPos.qty / 4)))
              }
              title="Quarter of your position"
            >
              ¼
            </button>
          )}
        </>
      )}

      {showBudget && (
        <div className="qf-popover">
          <button
            type="button"
            className="qf-chip"
            onClick={() => setBudgetOpen(!budgetOpen)}
            title="Buy by total dollar amount"
          >
            $ Total {budgetOpen ? '▴' : '▾'}
          </button>
          {budgetOpen && (
            <div className="qf-popover-content">
              <div className="qf-pop-label">Spend approximately</div>
              <div className="qf-pop-input-wrap">
                <span className="prefix">$</span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="qf-pop-hint">
                {sharesFromBudget > 0
                  ? `${sharesFromBudget} × $${refPrice.toFixed(2)} ≈ $${projectedCost.toFixed(2)}`
                  : 'Enter a positive amount.'}
              </div>
              <button
                type="button"
                className="qf-pop-apply"
                disabled={sharesFromBudget <= 0}
                onClick={() => {
                  if (sharesFromBudget > 0) {
                    setQty(sharesFromBudget);
                    setBudgetOpen(false);
                  }
                }}
              >
                {sharesFromBudget > 0
                  ? `Apply → ${sharesFromBudget} share${sharesFromBudget === 1 ? '' : 's'}`
                  : 'Apply'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
