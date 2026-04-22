import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Empty } from './Empty';
import { SEED_STOCKS } from '../lib/seedStocks';
import { fmtPct } from '../lib/format';
import type { Market } from '../lib/types';

interface AddStockModalProps {
  open: boolean;
  onClose: () => void;
  market: Market;
  onAdd: (ticker: string) => void;
  existing?: string[];
}

export function AddStockModal({
  open,
  onClose,
  market,
  onAdd,
  existing = [],
}: AddStockModalProps) {
  const [q, setQ] = useState('');

  const results = useMemo(() => {
    const query = q.trim().toUpperCase();
    return SEED_STOCKS.filter(
      (s) =>
        !query ||
        s.ticker.includes(query) ||
        s.name.toUpperCase().includes(query),
    ).slice(0, 12);
  }, [q]);

  return (
    <Modal open={open} onClose={onClose} title="Add to Watchlist" size="md">
      <div className="input-affix" style={{ marginBottom: 12 }}>
        <input
          className="input"
          placeholder="Search ticker or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>
      <div
        style={{
          maxHeight: 360,
          overflowY: 'auto',
          marginRight: -6,
          paddingRight: 6,
        }}
      >
        {results.map((s) => {
          const m = market[s.ticker];
          const added = existing.includes(s.ticker);
          const pct = m ? ((m.price - m.dayOpen) / m.dayOpen) * 100 : 0;
          return (
            <div
              key={s.ticker}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto',
                gap: 12,
                alignItems: 'center',
                padding: '10px 12px',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div>
                <div className="ticker">{s.ticker}</div>
                <div className="company">{s.name}</div>
              </div>
              <div className="mono tnum" style={{ textAlign: 'right' }}>
                <div>${m?.price.toFixed(2)}</div>
                <div
                  className={pct >= 0 ? 'up' : 'down'}
                  style={{ fontSize: 11.5 }}
                >
                  {fmtPct(pct)}
                </div>
              </div>
              <button
                className={`btn sm ${added ? '' : 'primary'}`}
                onClick={() => !added && onAdd(s.ticker)}
                disabled={added}
              >
                {added ? 'Added' : '+ Add'}
              </button>
            </div>
          );
        })}
        {results.length === 0 && (
          <Empty title="No matches" subtitle="Try a different search" />
        )}
      </div>
    </Modal>
  );
}
