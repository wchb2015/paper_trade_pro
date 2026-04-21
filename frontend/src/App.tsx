import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface PriceUpdate {
  symbol: string;
  price: number;
  ts: string;
}

interface ServerToClientEvents {
  price: (update: PriceUpdate) => void;
}
interface ClientToServerEvents {}

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  'http://localhost:4000'
);

export default function App() {
  const [price, setPrice] = useState<number | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onPrice = (data: PriceUpdate) => {
      if (data.symbol === 'TSLA') {
        setPrice(data.price);
        setLastUpdate(new Date(data.ts));
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('price', onPrice);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('price', onPrice);
    };
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui', padding: 40 }}>
      <h1>TSLA</h1>
      <div style={{ fontSize: 48, fontWeight: 'bold' }}>
        {price !== null ? `$${price.toFixed(2)}` : '—'}
      </div>
      <div style={{ color: '#666' }}>
        {connected ? '● Connected' : '○ Disconnected'}
        {lastUpdate && ` · Last trade: ${lastUpdate.toLocaleTimeString()}`}
      </div>
    </div>
  );
}

