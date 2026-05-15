import { api } from "@chongbei/web-basics/client";
import type {
  AddAlertInput,
  FillOrderInput,
  PlaceOrderInput,
  Portfolio,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
} from "../../../shared/src";
import { config } from "../config";

// -----------------------------------------------------------------------------
// Thin REST wrapper around the backend's /api portfolio endpoints. Every
// mutating call returns the whole Portfolio so usePortfolio can replace its
// state atomically — same shape the old localStorage hook used internally.
//
// Networking goes through `api<T>()` from @chongbei/web-basics: any non-2xx
// throws an ApiError with `{ status, code, ref, message }` AND fires a toast
// via the `configureApi` wiring in main.tsx. Callers catch to record the
// message in local state but don't need to toast themselves.
// -----------------------------------------------------------------------------

function url(path: string): string {
  return `${config.backendUrl}${path}`;
}

export const portfolioClient = {
  get(): Promise<Portfolio> {
    return api<Portfolio>(url("/api/portfolio"));
  },
  placeOrder(body: PlaceOrderInput): Promise<Portfolio> {
    return api<Portfolio>(url("/api/orders"), {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  cancelOrder(id: string): Promise<Portfolio> {
    return api<Portfolio>(url(`/api/orders/${encodeURIComponent(id)}/cancel`), {
      method: "POST",
    });
  },
  fillOrder(id: string, body: FillOrderInput): Promise<Portfolio> {
    return api<Portfolio>(url(`/api/orders/${encodeURIComponent(id)}/fill`), {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  addAlert(body: AddAlertInput): Promise<Portfolio> {
    return api<Portfolio>(url("/api/alerts"), {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  toggleAlert(id: string): Promise<Portfolio> {
    return api<Portfolio>(url(`/api/alerts/${encodeURIComponent(id)}/toggle`), {
      method: "POST",
    });
  },
  triggerAlert(id: string, body: TriggerAlertInput): Promise<Portfolio> {
    return api<Portfolio>(
      url(`/api/alerts/${encodeURIComponent(id)}/trigger`),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  removeAlert(id: string): Promise<Portfolio> {
    return api<Portfolio>(url(`/api/alerts/${encodeURIComponent(id)}`), {
      method: "DELETE",
    });
  },
  toggleWatch(body: ToggleWatchInput): Promise<Portfolio> {
    return api<Portfolio>(url("/api/watchlist/toggle"), {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  reset(body: ResetFundsInput = {}): Promise<Portfolio> {
    return api<Portfolio>(url("/api/portfolio/reset"), {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
};
