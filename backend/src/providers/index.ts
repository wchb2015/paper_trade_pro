import type { AppConfig } from '../config';
import { AlpacaProvider } from './AlpacaProvider';
import type { PriceProvider } from './PriceProvider';

/**
 * Factory. The only place in the app that knows which concrete provider to
 * instantiate. Add new providers here as they're implemented.
 */
export function createPriceProvider(cfg: AppConfig): PriceProvider {
  switch (cfg.provider) {
    case 'alpaca':
      return new AlpacaProvider(cfg);
    default: {
      // Exhaustiveness check — if someone adds a new provider name but
      // forgets to wire it in, TS will error here.
      const _never: never = cfg.provider;
      throw new Error(`Unhandled provider: ${String(_never)}`);
    }
  }
}

export type { PriceProvider } from './PriceProvider';
