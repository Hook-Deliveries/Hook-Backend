import { DEFAULT_DELIVERY_FEE_MINOR } from '@lib/constants';
import { DeliveryPricingRule } from '@models/platform/delivery-pricing.model';
import { OperationState } from '@models/platform/geography.model';
import { isValidObjectId } from 'mongoose';

type Coordinates = { latitude: number; longitude: number };

function activeRuleFilter(now: Date, scope: string, scopeIds: string[] = []) {
  return {
    scope,
    ...(scopeIds.length ? { scopeId: { $in: scopeIds } } : {}),
    status: 'active',
    $and: [
      { $or: [{ effectiveFrom: { $exists: false } }, { effectiveFrom: null }, { effectiveFrom: { $lte: now } }] },
      { $or: [{ effectiveUntil: { $exists: false } }, { effectiveUntil: null }, { effectiveUntil: { $gt: now } }] },
    ],
  } as any;
}

async function firstRule(scope: string, scopeIds: string[] = [], now: Date) {
  return DeliveryPricingRule.findOne({ ...activeRuleFilter(now, scope, scopeIds), mode: 'flat' })
    .sort({ version: -1, effectiveFrom: -1, createdAt: -1 })
    .lean({ virtuals: true }) as any;
}

export async function calculateDeliveryPricing(input: {
  state: any;
  coordinates?: Coordinates;
  defaultFeeMinor?: number;
}) {
  // Each State carries its own delivery price. It is the source of truth; the
  // older rule table is only a fallback for States that have none set yet.
  if (input.state && Number.isFinite(Number(input.state.deliveryFeeMinor)) && input.state.deliveryFeeMinor !== null && input.state.deliveryFeeMinor !== undefined) {
    return {
      scope: 'state' as const,
      mode: 'flat' as const,
      distanceKm: undefined,
      billableKm: undefined,
      feeMinor: Math.max(0, Math.round(Number(input.state.deliveryFeeMinor))),
      ruleVersion: `state-fee:${input.state.publicId || input.state.code}:${Math.round(Number(input.state.deliveryFeeMinor))}`,
      originHubId: undefined,
    };
  }
  const now = new Date();
  const stateId = String(input.state?.id || input.state?._id || '');
  const selectedRule = await firstRule('state', [stateId, String(input.state.publicId || '')].filter(Boolean), now)
    || await firstRule('global', undefined, now);
  const fallbackFee = Number(input.defaultFeeMinor ?? DEFAULT_DELIVERY_FEE_MINOR);
  if (!selectedRule) {
    return {
      scope: 'global' as const,
      mode: 'flat' as const,
      distanceKm: undefined,
      billableKm: undefined,
      feeMinor: fallbackFee,
      ruleVersion: 'global-fallback-v1',
      originHubId: undefined,
    };
  }

  const fallbackRuleFee = Number(selectedRule.fallbackFeeMinor ?? selectedRule.flatFeeMinor ?? fallbackFee);
  const fee = Number(selectedRule.flatFeeMinor ?? fallbackRuleFee);
  return {
    scope: selectedRule.scope,
    mode: 'flat' as const,
    distanceKm: undefined,
    billableKm: undefined,
    fallbackFeeMinor: fallbackRuleFee,
    feeMinor: Math.max(0, Math.round(fee)),
    ruleVersion: `${selectedRule.publicId}:v${selectedRule.version}`,
    originHubId: undefined,
  };
}

export async function resolveDeliveryState(identifier: string) {
  const alternatives: Array<Record<string, string>> = [
    { publicId: identifier },
    { code: String(identifier).toUpperCase() },
  ];
  if (isValidObjectId(identifier)) alternatives.push({ _id: identifier });
  return OperationState.findOne({
    countryCode: 'NG',
    status: 'active',
    $or: alternatives,
  }).lean({ virtuals: true });
}
