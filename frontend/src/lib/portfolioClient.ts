import { api } from "@chongbei/web-basics/client";
import type {
  AddAlertInput,
  FillOrderInput,
  HistoryRange,
  OkResponse,
  Order,
  PlaceOrderInput,
  Portfolio,
  PortfolioHistoryResponse,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
} from "../../../shared/src";

// -----------------------------------------------------------------------------
// Thin REST wrapper around the backend's /api portfolio endpoints. Every
// mutating call returns the whole Portfolio so usePortfolio can replace its
// state atomically — same shape the old localStorage hook used internally.
//
// Networking goes through `api<T>()` from @chongbei/web-basics: any non-2xx
// throws an ApiError with `{ status, code, ref, message }` AND fires a toast
// via the `configureApi` wiring in main.tsx. Callers catch to record the
// message in local state but don't need to toast themselves.
//
// Same-origin: all paths are relative. See frontend/src/config.ts.
// -----------------------------------------------------------------------------

export const portfolioClient = {
  get(): Promise<Portfolio> {
    return api<Portfolio>("/api/portfolio");
  },
  getHistory(range: HistoryRange): Promise<PortfolioHistoryResponse> {
    return api<PortfolioHistoryResponse>(
      `/api/portfolio/history?range=${encodeURIComponent(range)}`,
    );
  },
  placeOrder(body: PlaceOrderInput): Promise<Order> {
    return api<Order>("/api/orders", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  cancelOrder(id: string): Promise<Portfolio> {
    return api<Portfolio>(`/api/orders/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
  },
  fillOrder(id: string, body: FillOrderInput): Promise<Portfolio> {
    return api<Portfolio>(`/api/orders/${encodeURIComponent(id)}/fill`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  addAlert(body: AddAlertInput): Promise<Portfolio> {
    return api<Portfolio>("/api/alerts", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  toggleAlert(id: string): Promise<Portfolio> {
    return api<Portfolio>(`/api/alerts/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
    });
  },
  triggerAlert(id: string, body: TriggerAlertInput): Promise<Portfolio> {
    return api<Portfolio>(
      `/api/alerts/${encodeURIComponent(id)}/trigger`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  removeAlert(id: string): Promise<Portfolio> {
    return api<Portfolio>(`/api/alerts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  toggleWatch(body: ToggleWatchInput): Promise<Portfolio> {
    return api<Portfolio>("/api/watchlist/toggle", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  reset(body: ResetFundsInput = {}): Promise<OkResponse> {
    return api<OkResponse>("/api/portfolio/reset", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
};
