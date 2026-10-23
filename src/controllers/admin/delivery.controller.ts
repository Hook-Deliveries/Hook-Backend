import { Request, Response } from 'express';
import { announce } from '@services/engagement-notifications.service';
import { publishConfigChanged } from '@modules/platform/realtime.service';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { DeliveryPricingRule } from '@models/platform/delivery-pricing.model';
import { OperationState } from '@models/platform/geography.model';
import { calculateDeliveryPricing } from '@services/delivery-pricing.service';
import { OperationLocalGovernment } from '@models/platform/geography.model';
import { refreshNigerianLocationCatalog } from '@services/location-catalog.service';
import { nextPublicId } from '@modules/platform/public-id.service';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { DEFAULT_DELIVERY_FEE_MINOR } from '@lib/constants';
import { HttpError, sendSuccess } from '@utils/http';
import { adminDeliveryCache } from '@lib/ttl-cache';

function identity(value: string) {
  return [{ publicId: value }, ...( /^[a-f\d]{24}$/i.test(value) ? [{ _id: value }] : [])];
}

function cleanRule(rule: any) {
  return {
    publicId: rule.publicId,
    name: rule.name,
    scope: rule.scope,
    scopeId: rule.scopeId,
    mode: rule.mode,
    flatFeeMinor: rule.flatFeeMinor,
    originHubId: rule.originHubId,
    bands: rule.bands || [],
    status: rule.status,
    effectiveFrom: rule.effectiveFrom,
    effectiveUntil: rule.effectiveUntil,
    baseFeeMinor: rule.baseFeeMinor,
    feePerKmMinor: rule.feePerKmMinor,
    fallbackFeeMinor: rule.fallbackFeeMinor,
    version: rule.version,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export class AdminDeliveryController {
  settings = async (_req: Request, res: Response) => {
    const cached = adminDeliveryCache.get('settings');
    if (cached) {
      sendSuccess(res, cached);
      return;
    }
    const [settings, stateRows, lgaCounts, rules] = await Promise.all([
      CommerceSettings.findOne({ key: 'commerce' }).lean({ virtuals: true }),
      OperationState.find({ countryCode: 'NG' })
        .select('publicId name capitalName code status deliveryEnabled deliveryFeeMinor podEnabled podLimitMinor podMinimumOrderMinor deliveryPricingRuleId')
        .sort({ name: 1 }).lean({ virtuals: true }),
      OperationLocalGovernment.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$stateId', count: { $sum: 1 } } },
      ]),
      DeliveryPricingRule.find({}).sort({ scope: 1, name: 1 }).lean({ virtuals: true }),
    ]);
    const lgaCountByState = new Map(lgaCounts.map((item: any) => [String(item._id), item.count]));
    const states = stateRows.map((state: any) => ({
      publicId: state.publicId,
      name: state.name,
      capitalName: state.capitalName,
      code: state.code,
      status: state.status,
      deliveryEnabled: state.deliveryEnabled !== false,
      deliveryFeeMinor: state.deliveryFeeMinor,
      podEnabled: state.podEnabled === true,
      podLimitMinor: state.podLimitMinor ?? null,
      podMinimumOrderMinor: state.podMinimumOrderMinor ?? null,
      deliveryPricingRuleId: state.deliveryPricingRuleId,
      lgaCount: lgaCountByState.get(String(state.id || state._id)) || 0,
    }));
    const response = {
      settings: settings || {
        key: 'commerce',
        currency: 'NGN',
        defaultDeliveryFeeMinor: DEFAULT_DELIVERY_FEE_MINOR,
        podEnabled: false,
        defaultPodLimitMinor: 10000000,
        previewTtlMinutes: 10,
      },
      states,
      rules: rules.map(cleanRule),
    };
    adminDeliveryCache.set('settings', response);
    sendSuccess(res, response);
  };

  refreshLocations = async (req: Request, res: Response) => {
    const before = await OperationLocalGovernment.countDocuments({ status: 'active' });
    const result = await refreshNigerianLocationCatalog();
    await recordAudit(req, {
      action: 'delivery.location_catalog.refresh',
      entityType: 'nigerian_location_catalog',
      entityId: 'NG',
      before: { activeLgas: before },
      after: result,
      reason: req.body?.reason || 'Refreshed Nigerian State and LGA catalog',
    });
    adminDeliveryCache.clear();
    publishConfigChanged('delivery');
    sendSuccess(res, result);
  };

  updateSettings = async (req: Request, res: Response) => {
    const before = await CommerceSettings.findOne({ key: 'commerce' }).lean({ virtuals: true });
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: { defaultDeliveryFeeMinor: req.body.defaultDeliveryFeeMinor, updatedBy: req.user?.sub } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean({ virtuals: true });
    await recordAudit(req, { action: 'delivery.settings.update', entityType: 'commerce_settings', entityId: String(updated?.id || ''), before, after: updated, reason: req.body.reason });
    adminDeliveryCache.clear();
    publishConfigChanged('delivery');
    sendSuccess(res, updated);
  };

  listRules = async (_req: Request, res: Response) => {
    const rows = await DeliveryPricingRule.find({}).sort({ scope: 1, status: 1, name: 1 }).lean({ virtuals: true });
    sendSuccess(res, rows.map(cleanRule));
  };

  createRule = async (req: Request, res: Response) => {
    await this.assertScopeTarget(req.body.scope, req.body.scopeId);
    this.assertRuleValues(req.body);
    const rule = await DeliveryPricingRule.create({
      publicId: await nextPublicId('deliveryRule'),
      name: req.body.name,
      scope: req.body.scope,
      scopeId: req.body.scopeId,
      mode: req.body.mode,
      flatFeeMinor: req.body.flatFeeMinor,
      baseFeeMinor: req.body.baseFeeMinor,
      feePerKmMinor: req.body.feePerKmMinor,
      fallbackFeeMinor: req.body.fallbackFeeMinor,
      originHubId: req.body.originHubId,
      bands: req.body.bands || [],
      status: req.body.status || 'inactive',
      effectiveFrom: req.body.effectiveFrom,
      effectiveUntil: req.body.effectiveUntil,
      version: 1,
      createdBy: req.user?.sub,
      updatedBy: req.user?.sub,
    });
    await recordAudit(req, { action: 'delivery.pricing.create', entityType: 'delivery_pricing_rule', entityId: rule.id, entityPublicId: rule.publicId, before: undefined, after: rule.toJSON(), reason: req.body.reason });
    adminDeliveryCache.clear();
    publishConfigChanged('delivery');
    sendSuccess(res, cleanRule(rule.toJSON()));
  };

  updateRule = async (req: Request, res: Response) => {
    const rule = await DeliveryPricingRule.findOne({ $or: identity(String(req.params.id)) });
    if (!rule) throw new HttpError(404, 'Delivery pricing rule not found');
    const before = rule.toJSON();
    const nextScope = req.body.scope ?? rule.scope;
    const nextScopeId = nextScope === 'global' ? undefined : req.body.scopeId ?? rule.scopeId;
    const next = { ...rule.toObject(), ...req.body, scope: nextScope, scopeId: nextScopeId };
    await this.assertScopeTarget(next.scope, next.scopeId);
    this.assertRuleValues(next);
    Object.assign(rule, {
      name: req.body.name ?? rule.name,
      scope: nextScope,
      scopeId: nextScopeId,
      mode: req.body.mode ?? rule.mode,
      flatFeeMinor: req.body.flatFeeMinor ?? rule.flatFeeMinor,
      baseFeeMinor: req.body.baseFeeMinor ?? rule.baseFeeMinor,
      feePerKmMinor: req.body.feePerKmMinor ?? rule.feePerKmMinor,
      fallbackFeeMinor: req.body.fallbackFeeMinor ?? rule.fallbackFeeMinor,
      originHubId: req.body.originHubId ?? rule.originHubId,
      bands: req.body.bands ?? rule.bands,
      status: req.body.status ?? rule.status,
      effectiveFrom: req.body.effectiveFrom ?? rule.effectiveFrom,
      effectiveUntil: req.body.effectiveUntil ?? rule.effectiveUntil,
      version: rule.version + 1,
      updatedBy: req.user?.sub,
    });
    await rule.save();
    await recordAudit(req, { action: 'delivery.pricing.update', entityType: 'delivery_pricing_rule', entityId: rule.id, entityPublicId: rule.publicId, before, after: rule.toJSON(), reason: req.body.reason });
    adminDeliveryCache.clear();
    publishConfigChanged('delivery');
    sendSuccess(res, cleanRule(rule.toJSON()));
  };

  toggleState = async (req: Request, res: Response) => {
    const state = await OperationState.findOne({ $or: identity(String(req.params.id)) });
    if (!state) throw new HttpError(404, 'Operation State not found');
    const before = state.toJSON();
    const enabling = req.body.deliveryEnabled === true && state.deliveryEnabled === false;
    if (req.body.deliveryEnabled !== undefined) state.deliveryEnabled = Boolean(req.body.deliveryEnabled);
    // The customer's delivery price for this State. Checkout reads it directly.
    if (req.body.deliveryFeeMinor !== undefined) state.deliveryFeeMinor = Number(req.body.deliveryFeeMinor);
    // Pay on Delivery for this State: on/off, and the highest order value allowed (null clears it back to the global limit).
    if (req.body.podEnabled !== undefined) state.podEnabled = Boolean(req.body.podEnabled);
    if (req.body.podLimitMinor !== undefined) (state as any).podLimitMinor = req.body.podLimitMinor === null ? undefined : Number(req.body.podLimitMinor);
    // The smallest order that may use Pay on Delivery in this State (null goes back to the global minimum).
    if (req.body.podMinimumOrderMinor !== undefined) (state as any).podMinimumOrderMinor = req.body.podMinimumOrderMinor === null ? undefined : Number(req.body.podMinimumOrderMinor);
    await state.save();
    await recordAudit(req, { action: 'delivery.coverage.update', entityType: 'operation_state', entityId: state.id, entityPublicId: state.publicId, stateId: state.id, before, after: state.toJSON(), reason: req.body.reason });
    adminDeliveryCache.clear();
    publishConfigChanged('delivery');
    // Customers with an address in this State hear that delivery has started.
    if (enabling) void announce('new_state', `${state.publicId}:${Date.now()}`, { stateName: state.name }, { stateId: state.publicId, data: { stateId: state.publicId } }).catch(() => undefined);
    sendSuccess(res, { publicId: state.publicId, name: state.name, code: state.code, status: state.status, deliveryEnabled: state.deliveryEnabled, deliveryFeeMinor: state.deliveryFeeMinor, podEnabled: (state as any).podEnabled, podLimitMinor: (state as any).podLimitMinor ?? null, podMinimumOrderMinor: (state as any).podMinimumOrderMinor ?? null });
  };

  preview = async (req: Request, res: Response) => {
    const state = await OperationState.findOne({ $or: identity(String(req.body.stateId)), status: 'active', deliveryEnabled: { $ne: false } }).lean({ virtuals: true });
    if (!state) throw new HttpError(409, 'Selected State is not delivery-enabled', undefined, 'ADDRESS_OUTSIDE_COVERAGE');
    const pricing = await calculateDeliveryPricing({ state, coordinates: req.body.coordinates, defaultFeeMinor: (await CommerceSettings.findOne({ key: 'commerce' }).lean())?.defaultDeliveryFeeMinor });
    sendSuccess(res, pricing);
  };

  private async assertScopeTarget(scope: string, scopeId?: string) {
    if (scope === 'global') return;
    if (!scopeId) throw new HttpError(400, 'A State is required for this pricing scope');
    const exists = await OperationState.exists({
      $or: identity(String(scopeId)),
    });
    if (!exists) throw new HttpError(404, 'Pricing scope target not found');
  }

  private assertRuleValues(input: {
    mode: 'flat' | 'per_km' | 'distance_bands';
    flatFeeMinor?: number;
    baseFeeMinor?: number;
    feePerKmMinor?: number;
    fallbackFeeMinor?: number;
    bands?: Array<{ upToKm: number; feeMinor: number }>;
    effectiveFrom?: Date | string;
    effectiveUntil?: Date | string;
  }) {
    if (input.mode === 'flat' && input.flatFeeMinor == null) {
      throw new HttpError(400, 'A flat delivery rule requires a fee');
    }
    if (input.mode === 'per_km' && (
      !Number.isFinite(Number(input.baseFeeMinor)) || Number(input.baseFeeMinor) < 0
      || !Number.isFinite(Number(input.feePerKmMinor)) || Number(input.feePerKmMinor) < 0
    )) {
      throw new HttpError(400, 'Per-kilometer pricing requires a valid base fee and rate');
    }
    if (input.mode === 'distance_bands') {
      const bands = input.bands || [];
      if (!bands.length || bands.some((band) => !Number.isFinite(Number(band.upToKm)) || Number(band.upToKm) <= 0 || !Number.isFinite(Number(band.feeMinor)) || Number(band.feeMinor) < 0)) {
        throw new HttpError(400, 'Distance pricing requires valid distance bands');
      }
      for (let index = 1; index < bands.length; index += 1) {
        if (Number(bands[index].upToKm) <= Number(bands[index - 1].upToKm)) {
          throw new HttpError(400, 'Distance bands must be ordered by increasing distance');
        }
      }
    }
    if (input.effectiveFrom && input.effectiveUntil && new Date(input.effectiveUntil) <= new Date(input.effectiveFrom)) {
      throw new HttpError(400, 'The pricing rule end date must be after its start date');
    }
  }
}
