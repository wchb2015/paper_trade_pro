import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { SEED_STOCKS } from '../lib/seedStocks';
import type { AlertCondition, Market } from '../lib/types';

interface NewAlertModalProps {
  open: boolean;
  onClose: () => void;
  market: Market;
  ticker?: string;
  addAlert: (alert: {
    ticker: string;
    condition: AlertCondition;
    price: number;
    note?: string;
  }) => void;
}

export function NewAlertModal({
  open,
  onClose,
  market,
  ticker,
  addAlert,
}: NewAlertModalProps) {
  const [sel, setSel] = useState(ticker || 'AAPL');
  const [condition, setCondition] = useState<AlertCondition>('above');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      const t = ticker || 'AAPL';
      setSel(t);
      const m = market[t];
      if (m) setPrice(m.price.toFixed(2));
      setNote('');
    }
  }, [open, ticker, market]);

  const m = market[sel];

  const submit = () => {
    if (!price) return;
    addAlert({ ticker: sel, condition, price: +price, note });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="New Price Alert" size="sm">
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="label">Symbol</label>
        <select
          className="select"
          value={sel}
          onChange={(e) => setSel(e.target.value)}
        >
          {SEED_STOCKS.map((s) => (
            <option key={s.ticker} value={s.ticker}>
              {s.ticker} · {s.name}
            </option>
          ))}
        </select>
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 12,
        }}
      >
        Current price{' '}
        <span
          className="mono tnum"
          style={{ color: 'var(--text)', fontWeight: 600 }}
        >
          ${m?.price.toFixed(2)}
        </span>
      </div>
      <div
        className="segmented"
        style={{ display: 'flex', marginBottom: 12, width: '100%' }}
      >
        <button
          className={condition === 'above' ? 'active' : ''}
          style={{ flex: 1 }}
          onClick={() => setCondition('above')}
        >
          Price above
        </button>
        <button
          className={condition === 'below' ? 'active' : ''}
          style={{ flex: 1 }}
          onClick={() => setCondition('below')}
        >
          Price below
        </button>
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="label">Trigger Price</label>
        <div className="input-affix">
          <input
            className="input mono"
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <span className="affix">USD</span>
        </div>
      </div>
      <div className="field" style={{ marginBottom: 16 }}>
        <label className="label">Note (optional)</label>
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why this alert?"
        />
      </div>
      <button
        className="btn accent"
        style={{ width: '100%', padding: 11 }}
        onClick={submit}
        disabled={!price}
      >
        Create Alert
      </button>
    </Modal>
  );
}
