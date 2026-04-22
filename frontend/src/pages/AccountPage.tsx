import { useState } from 'react';
import { Icon } from '../components/Icon';
import { fmtMoney } from '../lib/format';
import { INITIAL_CASH } from '../hooks/usePortfolio';
import type { Portfolio, Valuation } from '../lib/types';

interface AccountPageProps {
  portfolio: Portfolio;
  valuation: Valuation;
  resetFunds: (amount?: number) => void;
}

export function AccountPage({
  portfolio,
  valuation,
  resetFunds,
}: AccountPageProps) {
  const [amount, setAmount] = useState<number>(INITIAL_CASH);
  const [confirm, setConfirm] = useState(false);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Account</h1>
          <div className="page-subtitle">
            Paper trading account · Simulated funds
          </div>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-label">Starting Cash</div>
          <div className="stat-value">{fmtMoney(portfolio.initialCash)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Current Equity</div>
          <div className="stat-value">{fmtMoney(valuation.equity)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Lifetime P&L</div>
          <div
            className="stat-value"
            style={{
              color: valuation.totalPnL >= 0 ? 'var(--up)' : 'var(--down)',
            }}
          >
            {fmtMoney(valuation.totalPnL, { signed: true })}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Reset funds</h3>
        </div>
        <div
          className="card-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              lineHeight: 1.55,
            }}
          >
            This wipes your positions, orders, and trade history, then restarts
            the account with the amount below. Useful when you want a clean
            slate to practice a new strategy.
          </div>
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-end',
              maxWidth: 360,
            }}
          >
            <div className="field" style={{ flex: 1 }}>
              <label className="label">Initial cash</label>
              <div className="input-affix">
                <input
                  className="input mono"
                  type="number"
                  step="1000"
                  min="1000"
                  value={amount}
                  onChange={(e) => setAmount(+e.target.value)}
                />
                <span className="affix">USD</span>
              </div>
            </div>
            <button className="btn" onClick={() => setAmount(100_000)}>
              $100K
            </button>
            <button className="btn" onClick={() => setAmount(500_000)}>
              $500K
            </button>
          </div>
          {!confirm ? (
            <div>
              <button className="btn" onClick={() => setConfirm(true)}>
                <Icon name="refresh" size={14} /> Reset account…
              </button>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: 14,
                background: 'var(--down-bg)',
                borderRadius: 8,
                alignItems: 'center',
              }}
            >
              <div style={{ flex: 1, fontSize: 13 }}>
                <strong>Confirm reset?</strong> All positions, orders, and
                history will be erased.
              </div>
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn sell"
                onClick={() => {
                  resetFunds(amount);
                  setConfirm(false);
                }}
              >
                Reset to {fmtMoney(amount, { digits: 0 })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
