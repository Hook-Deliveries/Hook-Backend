import { randomInt, randomUUID } from 'crypto';
import { HttpError } from '@utils/http';
import { FezLogisticsProvider } from '@modules/fulfilment/logistics/fez.provider';

export type LogisticsProviderName = 'gig' | 'fez' | 'manual' | 'simulated' | 'other';

export type LogisticsProvider = {
  readonly name: LogisticsProviderName;
  readonly enabled: boolean;
  quote(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  book(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancel(reference: string): Promise<Record<string, unknown>>;
  track(reference: string): Promise<Record<string, unknown>>;
  parseWebhook(payload: unknown, signature?: string): Record<string, unknown>;
  proofOfDelivery(reference: string): Promise<Record<string, unknown>>;
  returnShipment(reference: string): Promise<Record<string, unknown>>;
};

export class DisabledLogisticsProvider implements LogisticsProvider {
  readonly enabled = false;
  constructor(public readonly name: LogisticsProviderName) {}

  private unavailable(): never {
    throw new HttpError(503, `${this.name.toUpperCase()} logistics integration is not enabled`, undefined, 'PROVIDER_NOT_READY');
  }

  quote(_input: Record<string, unknown>) { return Promise.reject(this.unavailable()); }
  book(_input: Record<string, unknown>) { return Promise.reject(this.unavailable()); }
  cancel(_reference: string) { return Promise.reject(this.unavailable()); }
  track(_reference: string) { return Promise.reject(this.unavailable()); }
  parseWebhook(_payload: unknown, _signature?: string) { return this.unavailable(); }
  proofOfDelivery(_reference: string) { return Promise.reject(this.unavailable()); }
  returnShipment(_reference: string) { return Promise.reject(this.unavailable()); }
}

class SimulatedLogisticsProvider implements LogisticsProvider {
  readonly name = 'simulated' as const;
  readonly enabled = true;

  async quote(input: Record<string, unknown>) {
    return {
      mode: 'simulated',
      provider: this.name,
      quoteMinor: Number(input.providerQuoteMinor || 0),
      estimatedDeliveryAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async book(input: Record<string, unknown>) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    return {
      mode: 'simulated',
      provider: this.name,
      externalReference: `SIM-${suffix}`,
      trackingNumber: `HKSIM-${randomInt(100000, 1000000)}`,
      status: 'BOOKED_WITH_PROVIDER',
      orderId: input.orderId,
    };
  }

  async cancel(reference: string) { return { reference, mode: 'simulated', status: 'CANCELLED' }; }
  async track(reference: string) { return { reference, mode: 'simulated', status: 'BOOKED_WITH_PROVIDER' }; }
  parseWebhook(payload: unknown) { return { payload, mode: 'simulated' }; }
  async proofOfDelivery(reference: string) { return { reference, mode: 'simulated' }; }
  async returnShipment(reference: string) { return { reference, mode: 'simulated' }; }
}

export function isLogisticsSimulationEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.LOGISTICS_SIMULATION_ENABLED === 'true';
}

export function isFezLogisticsEnabled() {
  return process.env.LOGISTICS_FEZ_ENABLED === 'true';
}

export function logisticsReadiness() {
  return [
    { name: 'manual', enabled: true, mode: 'manual', reason: 'Audited manual booking is available.' },
    { name: 'simulated', enabled: isLogisticsSimulationEnabled(), mode: 'development-only', reason: 'Available only when NODE_ENV is non-production and LOGISTICS_SIMULATION_ENABLED=true.' },
    { name: 'gig', enabled: false, mode: 'provider', reason: 'Provider contract and credentials are not verified.' },
    { name: 'fez', enabled: isFezLogisticsEnabled(), mode: 'provider', reason: isFezLogisticsEnabled() ? 'Live.' : 'Set LOGISTICS_FEZ_ENABLED=true and the FEZ_* credentials to enable.' },
  ];
}

export function logisticsProvider(name: LogisticsProviderName): LogisticsProvider {
  if (name === 'manual') {
    return {
      name,
      enabled: true,
      async quote() { return { mode: 'manual' }; },
      async book() { return { mode: 'manual' }; },
      async cancel(reference) { return { reference, mode: 'manual' }; },
      async track(reference) { return { reference, mode: 'manual' }; },
      parseWebhook(payload) { return { payload, mode: 'manual' }; },
      async proofOfDelivery(reference) { return { reference, mode: 'manual' }; },
      async returnShipment(reference) { return { reference, mode: 'manual' }; },
    };
  }
  if (name === 'simulated' && isLogisticsSimulationEnabled()) return new SimulatedLogisticsProvider();
  if (name === 'fez' && isFezLogisticsEnabled()) return new FezLogisticsProvider();
  return new DisabledLogisticsProvider(name);
}
