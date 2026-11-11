import { LogisticsProvider } from '@models/logistics/logistics-provider.model';
import { OperationState } from '@models/platform/geography.model';
import { nextPublicId } from '@modules/platform';
import { HttpError } from '@utils/http';

function identity(identifier: string) {
  return /^[a-f\d]{24}$/i.test(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : { $or: [{ publicId: identifier }, { code: identifier.toUpperCase() }] };
}

/** Every State a message group names must exist, so a typo or a deleted State cannot silently leave customers with no message. */
async function assertKnownStates(rules: Array<{ stateIds: string[] }> | undefined) {
  const ids = [...new Set((rules || []).flatMap((rule) => rule.stateIds))];
  if (!ids.length) return;
  const found = await OperationState.find({ publicId: { $in: ids } }).select('publicId').lean();
  const known = new Set(found.map((state: any) => state.publicId));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new HttpError(400, `Unknown State: ${unknown.join(', ')}`, undefined, 'VALIDATION_ERROR');
}

export class LogisticsProviderService {
  /** The customer-facing picker at checkout. */
  async listActive() {
    return LogisticsProvider.find({ status: 'active', deletedAt: { $exists: false } })
      .select('publicId code name logoUrl description feeMinor deliveryEstimates defaultEstimate sortOrder')
      .sort({ sortOrder: 1, name: 1 })
      .lean({ virtuals: true });
  }

  async list() {
    return LogisticsProvider.find({ deletedAt: { $exists: false } })
      .sort({ sortOrder: 1, name: 1 })
      .lean({ virtuals: true });
  }

  async get(identifier: string) {
    const provider = await LogisticsProvider.findOne({
      ...identity(identifier),
      deletedAt: { $exists: false },
    }).lean({ virtuals: true });
    if (!provider) throw new HttpError(404, 'Logistics provider not found', undefined, 'NOT_FOUND');
    return provider;
  }

  /**
   * Resolves the provider a checkout selected. Rejects an inactive one so a
   * stale client cannot keep pricing against a courier admin has withdrawn.
   */
  async getSelectable(identifier: string) {
    const provider = await this.get(identifier);
    if (provider.status !== 'active') {
      throw new HttpError(409, 'That delivery option is no longer available', undefined, 'LOGISTICS_PROVIDER_UNAVAILABLE');
    }
    return provider;
  }

  async create(input: Record<string, unknown>, actorId: string) {
    await assertKnownStates(input.deliveryEstimates as any);
    const code = String(input.code).trim().toUpperCase();
    const existing = await LogisticsProvider.findOne({ code, deletedAt: { $exists: false } }).lean();
    if (existing) throw new HttpError(409, `A logistics provider with code "${code}" already exists`, undefined, 'CONFLICT');
    const { defaultEstimate, ...rest } = input;
    return LogisticsProvider.create({
      ...rest,
      ...(typeof defaultEstimate === 'string' && defaultEstimate.trim() ? { defaultEstimate: defaultEstimate.trim() } : {}),
      code,
      publicId: await nextPublicId('logisticsProvider'),
      createdBy: actorId,
    });
  }

  async update(identifier: string, input: Record<string, unknown>) {
    await assertKnownStates(input.deliveryEstimates as any);
    const provider = await this.get(identifier);
    if (input.code) {
      const code = String(input.code).trim().toUpperCase();
      const clash = await LogisticsProvider.findOne({
        code,
        _id: { $ne: provider._id },
        deletedAt: { $exists: false },
      }).lean();
      if (clash) throw new HttpError(409, `A logistics provider with code "${code}" already exists`, undefined, 'CONFLICT');
      input.code = code;
    }
    // An empty default message means "clear it".
    const { defaultEstimate, ...rest } = input;
    const update: Record<string, Record<string, unknown>> = { $set: rest };
    if (typeof defaultEstimate === 'string') {
      if (defaultEstimate.trim()) update.$set.defaultEstimate = defaultEstimate.trim();
      else update.$unset = { defaultEstimate: 1 };
    }
    const updated = await LogisticsProvider.findByIdAndUpdate(provider._id, update, { returnDocument: 'after' }).lean({ virtuals: true });
    return updated;
  }

  async remove(identifier: string) {
    const provider = await this.get(identifier);
    await LogisticsProvider.updateOne({ _id: provider._id }, { $set: { deletedAt: new Date() } });
    return { id: provider.publicId || String(provider._id), deleted: true };
  }
}
