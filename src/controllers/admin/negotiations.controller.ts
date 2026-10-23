import { Request, Response } from 'express';
import { NegotiationStatus, ScopeType } from '@lib/constants';
import { Market } from '@models/platform/network.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { Product } from '@models/products/product.model';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { User } from '@models/users/user.model';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { HttpError, sendSuccess } from '@utils/http';
import { routeParam } from './admin.helpers';

function identifier(value: string) {
  return /^[a-f\d]{24}$/i.test(value)
    ? { $or: [{ _id: value }, { publicId: value }] }
    : { publicId: value };
}

function safeSession(session: any, product?: any, includeTranscript = false) {
  return {
    id: session.publicId,
    status: session.status,
    channel: session.channel,
    product: product ? {
      id: product.publicId,
      name: product.title || product.name,
      images: product.images || [],
    } : null,
    quantity: session.quantity,
    currency: session.currency,
    offerCount: session.offerCount,
    maximumOffers: session.maximumOffers,
    lastDecision: session.lastDecision || null,
    agreedPriceMinor: session.agreedPriceMinor || null,
    language: session.language || 'english',
    providerFallback: Boolean((session.providerTelemetry || []).some((entry: any) => entry.failed)),
    ...(includeTranscript ? { transcript: session.transcript || [] } : {}),
    ...(includeTranscript ? { providerTelemetry: (session.providerTelemetry || []).map((entry: any) => ({
      provider: entry.provider,
      failed: Boolean(entry.failed),
      failureCode: entry.failureCode || null,
    })) } : {}),
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export class AdminNegotiationsController {
  private async scope(req: Request): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = {};
    if (req.user?.scopeType !== ScopeType.GLOBAL) {
      filter.sourceStateId = { $in: req.user?.assignedStateIds || [] };
      if (req.user?.scopeType === ScopeType.HUB) {
        const markets = await Market.find({ hubId: { $in: req.user.assignedHubIds || [] } }).select('_id publicId').lean();
        filter.marketId = { $in: markets.flatMap((entry) => [entry._id.toString(), entry.publicId]) };
      }
    }
    if (req.platformContext?.stateId) filter.sourceStateId = req.platformContext.stateId;
    if (req.platformContext?.hubId) {
      const markets = await Market.find({ hubId: req.platformContext.hubId }).select('_id publicId').lean();
      filter.marketId = { $in: markets.flatMap((entry) => [entry._id.toString(), entry.publicId]) };
    }
    return filter;
  }
  list = async (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const filter: Record<string, unknown> = await this.scope(req);
    if (req.query.status && Object.values(NegotiationStatus).includes(req.query.status as NegotiationStatus)) {
      filter.status = req.query.status;
    }
    if (req.platformContext?.stateId) filter.sourceStateId = req.platformContext.stateId;
    const [sessions, total, accepted, active, fallbackSessions] = await Promise.all([
      Negotiation.find(filter)
        .select('publicId status channel customerId productId quantity currency offerCount maximumOffers lastDecision agreedPriceMinor language providerTelemetry expiresAt createdAt updatedAt')
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .lean({ virtuals: true }),
      Negotiation.countDocuments(filter),
      Negotiation.countDocuments({
        ...filter,
        status: { $in: [NegotiationStatus.AGREED, NegotiationStatus.ACCEPTED] },
      }),
      Negotiation.countDocuments({ ...filter, status: NegotiationStatus.ACTIVE }),
      Negotiation.countDocuments({ ...filter, 'providerTelemetry.failed': true }),
    ]);
    const page = sessions.slice(0, limit);
    const products = await Product.find({ _id: { $in: page.map((item) => item.productId) } })
      .select('publicId title name images')
      .lean({ virtuals: true });
    const productById = new Map(products.map((product) => [product._id.toString(), product]));
    const customers = await User.find({ _id: { $in: page.map((item) => item.customerId).filter(Boolean) } }).select('firstName lastName email').lean();
    const customerById = new Map(customers.map((customer) => [customer._id.toString(), customer]));
    sendSuccess(res, {
      data: page.map((session) => ({ ...safeSession(session, productById.get(session.productId)), customer: customerById.get(session.customerId || '') || null })),
      total,
      hasMore: sessions.length > limit,
      accepted,
      conversionRate: total ? Math.round((accepted / total) * 10_000) / 100 : 0,
      active,
      fallbackRate: total ? Math.round((fallbackSessions / total) * 10_000) / 100 : 0,
    });
  };

  detail = async (req: Request, res: Response) => {
    const filter: Record<string, unknown> = { ...identifier(routeParam(req.params.id)), ...await this.scope(req) };
    if (req.platformContext?.stateId) filter.sourceStateId = req.platformContext.stateId;
    const session = await Negotiation.findOne(filter).lean({ virtuals: true });
    if (!session) throw new HttpError(404, 'Negotiation not found', undefined, 'NOT_FOUND');
    const product = await Product.findById(session.productId).select('publicId title name images').lean({ virtuals: true });
    const canReadTranscript = req.user?.roleKeys?.includes('SUPER_ADMIN') || req.user?.permissions?.includes('ai_negotiation.transcript.view');
    const customer = session.customerId ? await User.findById(session.customerId).select('firstName lastName email').lean() : null;
    if (canReadTranscript) await recordAudit(req, { action: 'negotiation.transcript_viewed', entityType: 'negotiation', entityPublicId: session.publicId });
    sendSuccess(res, { ...safeSession(session, product, Boolean(canReadTranscript)), customer, transcriptRestricted: !canReadTranscript });
  };

  settings = async (_req: Request, res: Response) => {
    const settings = await CommerceSettings.findOne({ key: 'commerce' })
      .select('negotiationEnabled negotiationSessionMode negotiationSessionMinutes negotiationMaximumOffers negotiationQuoteMinutes negotiationAzureWordingEnabled updatedAt')
      .lean();
    sendSuccess(res, {
      enabled: settings?.negotiationEnabled !== false,
      sessionMode: settings?.negotiationSessionMode || 'fixed',
      sessionMinutes: settings?.negotiationSessionMinutes || 10,
      maximumOffers: settings?.negotiationMaximumOffers || 3,
      quoteMinutes: settings?.negotiationQuoteMinutes || 30,
      azureWordingEnabled: settings?.negotiationAzureWordingEnabled !== false,
      providerConfigured: Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT_NAME && process.env.AZURE_OPENAI_API_VERSION),
      updatedAt: settings?.updatedAt,
    });
  };

  updateSettings = async (req: Request, res: Response) => {
    const before = await CommerceSettings.findOne({ key: 'commerce' }).lean();
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: {
        negotiationEnabled: req.body.enabled,
        negotiationSessionMode: req.body.sessionMode,
        negotiationSessionMinutes: req.body.sessionMinutes,
        negotiationMaximumOffers: req.body.maximumOffers,
        negotiationQuoteMinutes: req.body.quoteMinutes,
        negotiationAzureWordingEnabled: req.body.azureWordingEnabled,
        updatedBy: req.user!.sub,
      } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
    await recordAudit(req, { action: 'negotiation.settings_updated', entityType: 'commerce_settings', before, after: updated, reason: req.body.reason });
    sendSuccess(res, { message: 'Negotiation settings updated' });
  };
}
