import { HttpError } from '@utils/http';
import { FezLogisticsProvider } from '@modules/fulfilment/logistics/fez.provider';

export type LogisticsProviderName = 'fez' | 'manual';

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

export function isFezLogisticsEnabled() {
  return process.env.LOGISTICS_FEZ_ENABLED === 'true';
}

export function logisticsReadiness() {
  return [
    { name: 'manual', enabled: true, mode: 'manual', reason: 'Audited manual booking is available.' },
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
  if (name === 'fez' && isFezLogisticsEnabled()) return new FezLogisticsProvider();
  return new DisabledLogisticsProvider(name);
}
