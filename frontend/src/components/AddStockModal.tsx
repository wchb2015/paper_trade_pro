import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { priceClient } from '../lib/priceClient';

interface AddStockModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (ticker: string) => void;
  existing?: string[];
}

const TICKER_RE = /^[A-Z][A-Z0-9.]{0,7}$/;

export function AddStockModal({
  open,
  onClose,
  onAdd,
  existing = [],
}: AddStockModalProps) {
  const [raw, setRaw] = useState('');
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tracks whether the modal is still mounted so an in-flight validation
  // doesn't write state into a tear-down. The modal is unmounted on close
  // (`{addOpen && <AddStockModal …/>}`), so this is the easiest way to drop
  // late results without warnings. The `useState` initializers also run
  // fresh on every mount, so we don't need an open→reset effect.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    const sym = raw.trim().toUpperCase();
    if (!sym) {
      setError('Enter a ticker symbol.');
      return;
    }
    if (!TICKER_RE.test(sym)) {
      setError(
        'Use letters, digits, or dot (e.g. AAPL, BRK.B). Max 8 characters.',
      );
      return;
    }
    if (existing.includes(sym)) {
      setError(`${sym} is already on your watchlist.`);
      return;
    }

    setValidating(true);
    setError(null);

    try {
      // Catalog lookup is provider-mode-independent — we want "is JD a real,
      // tradable ticker?", not "do we have a price for it right now?". A
      // valid symbol with no recent print (illiquid pre-market, replay
      // missing fixture) should still pass.
      const res = await priceClient.lookupAsset(sym);
      if (!mountedRef.current) return;

      if (!res.asset) {
        setError(`${sym} is not a recognized symbol.`);
        return;
      }
      if (!res.asset.tradable) {
        setError(
          `${res.asset.symbol} is recognized but currently not tradable (delisted or halted).`,
        );
        return;
      }
      onAdd(res.asset.symbol);
      onClose();
    } catch (err) {
      // api() already toasted with a ref id; surface the message inline so
      // the user also has feedback inside the modal.
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      if (mountedRef.current) setValidating(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add to Watchlist" size="sm">
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="label">Ticker symbol</label>
        <input
          className="input mono"
          placeholder="e.g. NVDA"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value.toUpperCase());
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !validating) void submit();
          }}
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          disabled={validating}
        />
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--text-muted)',
            marginTop: 6,
          }}
        >
          We'll check that this is a real, tradable symbol before adding it.
          Prices appear once the feed has a quote.
        </div>
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
        onClick={() => void submit()}
        disabled={validating || raw.trim().length === 0}
      >
        {validating ? 'Checking…' : 'Add'}
      </button>
    </Modal>
  );
}
