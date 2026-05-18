import { api } from "@chongbei/web-basics/client";
import type { MarketClockResponse } from "../../../shared/src";
import { config } from "../config";

// -----------------------------------------------------------------------------
// Thin client for market metadata endpoints. Today this is just the clock.
// Networking goes through `api<T>()` (toast on error, ApiError on non-2xx) —
// same shape as the rest of the frontend API surface.
// -----------------------------------------------------------------------------

function url(path: string): string {
  return `${config.backendUrl}${path}`;
}

export const marketClient = {
  getClock(): Promise<MarketClockResponse> {
    return api<MarketClockResponse>(url("/api/market/clock"));
  },
};
