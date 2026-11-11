import type { DeliveryEstimateRule } from '@models/logistics/logistics-provider.model';

/**
 * The delivery-time message a customer sees for a courier: the message of the rule that lists their delivery State, else the
 * courier's default, else nothing. States are matched by publicId (STA-...), code or name so an address saved before the
 * State ids were stable still resolves.
 */
export function resolveDeliveryEstimate(
  provider: { deliveryEstimates?: DeliveryEstimateRule[]; defaultEstimate?: string },
  state?: { publicId?: string; code?: string; name?: string } | null,
): string | undefined {
  const keys = [state?.publicId, state?.code, state?.name].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  if (keys.length) {
    const rule = (provider.deliveryEstimates || []).find((candidate) => candidate.stateIds.some((id) => keys.includes(String(id).trim().toLowerCase())));
    if (rule?.message) return rule.message;
  }
  return provider.defaultEstimate?.trim() || undefined;
}
