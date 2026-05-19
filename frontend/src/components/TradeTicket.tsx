import { Modal } from './Modal';
import { TradeForm } from './TradeForm';
import type {
  Market,
  OrderSide,
  Portfolio,
} from '../lib/types';
import type { PlaceOrderInput } from '../hooks/usePortfolio';

interface TradeTicketProps {
  open: boolean;
  onClose: () => void;
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  placeOrder: (order: PlaceOrderInput) => void;
  initialSide?: OrderSide;
}

export function TradeTicket({
  open,
  onClose,
  ticker,
  market,
  portfolio,
  placeOrder,
  initialSide = 'buy',
}: TradeTicketProps) {
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title={`Trade · ${ticker}`} size="md">
      <TradeForm
        ticker={ticker}
        market={market}
        portfolio={portfolio}
        placeOrder={placeOrder}
        initialSide={initialSide}
        onDone={onClose}
        layout="modal"
      />
    </Modal>
  );
}
