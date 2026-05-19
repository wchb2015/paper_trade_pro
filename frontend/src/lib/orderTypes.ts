import type { OrderType } from './types';

// Display labels for every OrderType the system can store. The new TradeForm
// only writes 'market' and 'limit', but historical orders may carry the older
// types — this list lets OrdersPage label them without resurrecting the old
// trade ticket.
export const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'stop', label: 'Stop Loss' },
  { value: 'stop_limit', label: 'Stop Limit' },
  { value: 'trailing_stop', label: 'Trailing Stop' },
  { value: 'conditional', label: 'Conditional' },
];
