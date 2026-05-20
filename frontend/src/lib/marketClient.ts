import { api } from "@chongbei/web-basics/client";
import type { MarketClockResponse } from "../../../shared/src";

// -----------------------------------------------------------------------------
// Thin client for market metadata endpoints. Today this is just the clock.
// Networking goes through `api<T>()` (toast on error, ApiError on non-2xx) —
// same shape as the rest of the frontend API surface.
//
// Same-origin: all paths are relative. See frontend/src/config.ts.
// -----------------------------------------------------------------------------

export const marketClient = {
  getClock(): Promise<MarketClockResponse> {
    return api<MarketClockResponse>("/api/market/clock");
  },
};
