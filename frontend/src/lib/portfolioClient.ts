import type {
  AddAlertInput,
  FillOrderInput,
  PlaceOrderInput,
  Portfolio,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
} from '../../../shared/src';
import { config } from '../config';

// -----------------------------------------------------------------------------
// Thin REST wrapper around the backend's /api portfolio endpoints. Every
// mutating call returns the whole Portfolio so usePortfolio can replace its
// state atomically — same shape the old localStorage hook used internally.
// -----------------------------------------------------------------------------

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${config.backendUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Try to surface the server's `{error: "..."}` if it sent one.
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed && typeof parsed.error === 'string') message = parsed.error;
    } catch {
      /* fall through */
    }
    throw new Error(`${path} ${res.status}: ${message}`);
  }
  return (await res.json()) as T;
}

export const portfolioClient = {
  get(): Promise<Portfolio> {
    return request<Portfolio>('/api/portfolio');
  },
  placeOrder(body: PlaceOrderInput): Promise<Portfolio> {
    return request<Portfolio>('/api/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  cancelOrder(id: string): Promise<Portfolio> {
    return request<Portfolio>(`/api/orders/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  },
  fillOrder(id: string, body: FillOrderInput): Promise<Portfolio> {
    return request<Portfolio>(`/api/orders/${encodeURIComponent(id)}/fill`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  addAlert(body: AddAlertInput): Promise<Portfolio> {
    return request<Portfolio>('/api/alerts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  toggleAlert(id: string): Promise<Portfolio> {
    return request<Portfolio>(`/api/alerts/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
    });
  },
  triggerAlert(id: string, body: TriggerAlertInput): Promise<Portfolio> {
    return request<Portfolio>(`/api/alerts/${encodeURIComponent(id)}/trigger`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  removeAlert(id: string): Promise<Portfolio> {
    return request<Portfolio>(`/api/alerts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
  toggleWatch(body: ToggleWatchInput): Promise<Portfolio> {
    return request<Portfolio>('/api/watchlist/toggle', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  reset(body: ResetFundsInput = {}): Promise<Portfolio> {
    return request<Portfolio>('/api/portfolio/reset', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};
