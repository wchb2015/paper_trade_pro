import type { Alert } from './types';

// Tracks "the last time the user opened the Alerts page". Anything triggered
// after this moment counts as unread and drives the sidebar's red dot.
// Stored in localStorage for cheap persistence; sync across devices is not a
// goal for a single-user paper-trading app.
const KEY = 'paperTradePro.lastAlertsViewedAt';

export function getLastViewedAt(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.error('ERROR getLastViewedAt failed', err);
    return 0;
  }
}

export function markViewedNow(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch (err) {
    console.error('ERROR markViewedNow failed', err);
  }
}

/**
 * Count of triggered alerts the user has not yet seen. The sidebar's red dot
 * shows when this is > 0.
 */
export function countUnreadTriggered(alerts: Alert[]): number {
  const cutoff = getLastViewedAt();
  let n = 0;
  for (const a of alerts) {
    if (a.triggeredAt && a.triggeredAt > cutoff) n++;
  }
  return n;
}
