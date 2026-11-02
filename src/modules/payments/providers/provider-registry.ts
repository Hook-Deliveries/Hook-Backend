import { HttpError } from "@utils/http";
import type { PaymentProvider } from "@modules/payments/providers/payment-provider";
import { PaystackProvider } from "@modules/payments/providers/paystack.provider";
import { MonnifyProvider } from "@modules/payments/providers/monnify.provider";

export type ProviderName = "paystack" | "monnify";

const providers: Record<ProviderName, PaymentProvider> = {
  paystack: new PaystackProvider(),
  monnify: new MonnifyProvider(),
};

export function paymentProvider(name: ProviderName) {
  const provider = providers[name];
  if (!provider) throw new HttpError(400, "Unsupported payment provider", undefined, "PAYMENT_PROVIDER_NOT_SUPPORTED");
  return provider;
}

export function paymentProviderReadiness() {
  return (Object.keys(providers) as ProviderName[]).map((name) => ({ provider: name, ...providers[name].readiness() }));
}

/** The provider new payments should use: whichever CommerceSettings marks isDefault, else paystack. */
export async function defaultProviderName(): Promise<ProviderName> {
  const { CommerceSettings } = await import("@models/commerce/commerce.model");
  const settings = await CommerceSettings.findOne({ key: "commerce" }).select("paymentProviders").lean();
  const marked = settings?.paymentProviders?.find((entry) => entry.isDefault && entry.enabled);
  return (marked?.provider as ProviderName) || "paystack";
}
