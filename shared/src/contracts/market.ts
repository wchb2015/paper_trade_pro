// -----------------------------------------------------------------------------
// Market-clock contract — shared by the backend (Alpaca-backed MarketClock)
// and the frontend (useMarketClock hook, TradeTicket disabled state).
//
// Sourced from Alpaca's /v2/clock endpoint:
//   https://docs.alpaca.markets/reference/getclock
// Alpaca returns ISO-8601 timestamps; the backend converts them to epoch-ms
// over the wire so the frontend can do plain Date math (consistent with the
// rest of our API per the timezone rule in CLAUDE.md).
// -----------------------------------------------------------------------------

export interface MarketClockResponse {
  /**
   * Is the U.S. equities regular session currently open? Alpaca's /clock is
   * authoritative — it accounts for weekends and the official NYSE holiday
   * calendar (including early-close days, where `isOpen` flips at 13:00 ET).
   */
  isOpen: boolean;
  /** Epoch-ms (UTC) of the next regular-session open. */
  nextOpen: number;
  /** Epoch-ms (UTC) of the next regular-session close. */
  nextClose: number;
  /**
   * Epoch-ms when the backend last fetched /clock. Lets clients reason about
   * staleness without trusting their own wall-clock.
   */
  fetchedAt: number;
}
