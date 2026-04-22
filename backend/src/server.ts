import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import WebSocket from 'ws';
import { Server } from 'socket.io';

// --- Types for Alpaca's WS messages ---
// Alpaca sends arrays of messages, each tagged with a `T` discriminator.
interface AlpacaAuthMessage {
  T: 'success' | 'error' | 'subscription';
  msg?: string;
  code?: number;
}

interface AlpacaTradeMessage {
  T: 't';
  S: string;   // symbol
  p: number;   // price
  s: number;   // size
  t: string;   // RFC-3339 timestamp
  i: number;   // trade ID
  x: string;   // exchange code
}

interface AlpacaQuoteMessage {
  T: 'q';
  S: string;
  bp: number;  // bid price
  ap: number;  // ask price
  t: string;
}

type AlpacaMessage = AlpacaAuthMessage | AlpacaTradeMessage | AlpacaQuoteMessage;

// --- Types for what we send to the frontend ---
interface PriceUpdate {
  symbol: string;
  price: number;
  ts: string;
}

// --- Socket.io event typing (shared with frontend if you want) ---
interface ServerToClientEvents {
  price: (update: PriceUpdate) => void;
}
interface ClientToServerEvents {
  // add later: subscribe, unsubscribe
}

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: 'http://localhost:5173' },
});

const latestPrices: Record<string, PriceUpdate> = {};
const SYMBOLS = ['TSLA'];

const ALPACA_WS = 'wss://stream.data.alpaca.markets/v2/iex';

function connectAlpaca(): void {
  const ws = new WebSocket(ALPACA_WS);

  ws.on('open', () => {
    console.log('Alpaca WS connected');
    ws.send(JSON.stringify({
      action: 'auth',
      key: process.env.APCA_KEY_ID,
      secret: process.env.APCA_SECRET_KEY,
    }));
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    const messages = JSON.parse(raw.toString()) as AlpacaMessage[];
    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        ws.send(JSON.stringify({
          action: 'subscribe',
          trades: SYMBOLS,
          quotes: SYMBOLS,
        }));
        console.log('Subscribed to', SYMBOLS);
      } else if (msg.T === 't') {
        const update: PriceUpdate = { symbol: msg.S, price: msg.p, ts: msg.t };
        latestPrices[msg.S] = update;
        io.emit('price', update);
      } else if (msg.T === 'error') {
        console.error('Alpaca error:', msg);
      }
    }
  });

  ws.on('close', () => {
    console.log('Alpaca WS closed, reconnecting in 5s...');
    setTimeout(connectAlpaca, 5000);
  });

  ws.on('error', (err: Error) => console.error('WS error:', err.message));
}

connectAlpaca();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  for (const sym of SYMBOLS) {
    const latest = latestPrices[sym];
    if (latest) socket.emit('price', latest);
  }
});

const PORT = Number(process.env.PORT) || 4000;
// --- Debug: log latest TSLA price every 5 seconds ---
setInterval(() => {
  const tsla = latestPrices['TSLA'];
  if (tsla) {
    console.log(`[${new Date().toLocaleTimeString()}] TSLA: $${tsla.price.toFixed(2)} (trade at ${tsla.ts})`);
  } else {
    console.log(`[${new Date().toLocaleTimeString()}] TSLA: no price yet`);
  }
}, 5000);
server.listen(PORT, () => console.log(`Backend on :${PORT}`));

