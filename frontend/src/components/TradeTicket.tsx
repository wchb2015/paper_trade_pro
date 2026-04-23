import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { STOCK_META } from '../lib/seedStocks';
import type {
  Market,
  OrderSide,
  OrderType,
  Portfolio,
  TimeInForce,
} from '../lib/types';
import type { PlaceOrderInput } from '../hooks/usePortfolio';

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

  const m = market[ticker];
  const refPrice = m?.price ?? 0;

  useEffect(() => {
    if (open && m) {
      setLimitPrice(m.price.toFixed(2));
      setStopPrice(
        (m.price * (side === 'buy' ? 1.02 : 0.98)).toFixed(2),
      );
      setCondTicker(ticker);
      setCondPrice(m.price.toFixed(2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ticker, m?.price]);

  useEffect(() => {
    setSide(initialSide);
    setMode(
      initialSide === 'short' || initialSide === 'cover' ? 'short' : 'long',
    );
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

  const estimate = useMemo(() => {
    const p =
      type === 'market'
        ? side === 'buy' || side === 'cover'
          ? m?.ask
          : m?.bid
        : type === 'limit'
          ? +limitPrice
          : type === 'stop'
            ? refPrice
            : type === 'stop_limit'
              ? +limitPrice
              : refPrice;
    const amount = (p || 0) * (+qty || 0);
    return { price: p || 0, amount };
  }, [type, side, qty, limitPrice, refPrice, m]);

  const buyingPower = portfolio.cash;
  const affordable =
    side === 'buy' || side === 'cover'
      ? estimate.amount <= buyingPower
      : true;

  const submit = () => {
    const numQty = +qty;
    if (!numQty || numQty <= 0) return;
    const order: PlaceOrderInput = {
      ticker,
      side,
      type,
      qty: numQty,
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
    placeOrder(order);
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
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {m.name}
          </div>
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
          <label className="label">Quantity</label>
          <input
            className="input mono"
            type="number"
            min="1"
            step="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
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
            <select
              className="select"
              style={{ flex: 1 }}
              value={condTicker}
              onChange={(e) => setCondTicker(e.target.value)}
            >
              {STOCK_META.map((s) => (
                <option key={s.ticker} value={s.ticker}>
                  {s.ticker}
                </option>
              ))}
            </select>
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

      <button
        className={`btn ${sideColor}`}
        style={{ width: '100%', padding: '12px', fontSize: 14, fontWeight: 600 }}
        disabled={!affordable || !qty || +qty <= 0}
        onClick={submit}
      >
        {side.toUpperCase()} {qty} {ticker}{' '}
        {type !== 'market' ? `· ${typeLabel}` : ''}
      </button>
    </Modal>
  );
}
