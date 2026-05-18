import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
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

const TICKER_RE = /^[A-Z][A-Z0-9.]{0,7}$/;

export function NewAlertModal({
  open,
  onClose,
  market,
  ticker,
  addAlert,
}: NewAlertModalProps) {
  const [sel, setSel] = useState(ticker || '');
  const [condition, setCondition] = useState<AlertCondition>('above');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Seed inputs only when the modal transitions from closed → open. The live
  // `market` ref changes on every price tick; depending on it would clobber
  // whatever the user is typing into the Trigger Price field.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const t = ticker || '';
      setSel(t);
      const m = t ? market[t] : undefined;
      setPrice(m ? m.price.toFixed(2) : '');
      setNote('');
      setError(null);
    }
    wasOpenRef.current = open;
  }, [open, ticker, market]);

  const m = sel ? market[sel] : undefined;

  const submit = () => {
    const sym = sel.trim().toUpperCase();
    if (!sym) {
      setError('Enter a ticker symbol.');
      return;
    }
    if (!TICKER_RE.test(sym)) {
      setError('Use letters, digits, or dot (e.g. AAPL, BRK.B).');
      return;
    }
    if (!price) {
      setError('Enter a trigger price.');
      return;
    }
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      setError('Trigger price must be a positive number.');
      return;
    }
    addAlert({ ticker: sym, condition, price: numericPrice, note });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="New Price Alert" size="sm">
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="label">Symbol</label>
        <input
          className="input mono"
          placeholder="e.g. AAPL"
          value={sel}
          onChange={(e) => {
            setSel(e.target.value.toUpperCase());
            if (error) setError(null);
          }}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
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
          {m ? `$${m.price.toFixed(2)}` : '—'}
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
      {error && (
        <div
          role="alert"
          style={{
            padding: '8px 10px',
            marginBottom: 12,
            borderRadius: 6,
            background: 'rgba(225, 29, 72, 0.10)',
            color: 'var(--down)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}
      <button
        className="btn accent"
        style={{ width: '100%', padding: 11 }}
        onClick={submit}
        disabled={!price || !sel.trim()}
      >
        Create Alert
      </button>
    </Modal>
  );
}
