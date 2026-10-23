import { createHash, randomUUID } from 'crypto';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { NegotiationCommand } from '@models/negotiations/command.model';
import { HttpError } from '@utils/http';
import { NegotiationService, type NegotiationIdentity } from './negotiation.service';
import { NegotiationShoppingService } from './negotiation-shopping.service';
import { publishRealtime } from '@modules/platform/realtime.service';
import { HookPartner } from '@models/platform/operations-accounts.model';
import { withNegotiationExecution } from '@lib/negotiation-execution';

export class NegotiationCommandService {
  async run(identity: NegotiationIdentity, id: string, key: string, payload: { message: string } | { offeredPriceMinor?: number; message?: string }) {
    if (!key || key.length < 8 || key.length > 200) throw new HttpError(400, 'Idempotency-Key required');
    const filter = { publicId: id, customerId: identity.customerId, ...(identity.partnerId ? { initiatingPartnerId: identity.partnerId } : {}) };
    const session = await Negotiation.findOne(filter).select('_id publicId customerId initiatingPartnerId').lean();
    if (!session) throw new HttpError(404, 'Negotiation not found');
    const actorId = identity.partnerId || identity.customerId;
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const commandFilter = { negotiationId: id, actorId, key };
    let command;
    try {
      command = await NegotiationCommand.findOneAndUpdate(commandFilter,
        { $setOnInsert: { ...commandFilter, hash, status: 'pending' } }, { upsert: true, returnDocument: 'after' }).lean();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      command = await NegotiationCommand.findOne(commandFilter).lean();
    }
    if (!command || command.hash !== hash) throw new HttpError(409, 'Request key already used for another message', undefined, 'IDEMPOTENCY_CONFLICT');
    if (command.status === 'completed') return command.response;
    const owner = randomUUID();
    const locked = await Negotiation.updateOne({ ...filter, $or: [{ commandLock: { $exists: false } }, { 'commandLock.expiresAt': { $lte: new Date() } }] },
      { $set: { commandLock: { owner, expiresAt: new Date(Date.now() + 120_000) } } });
    if (!locked.modifiedCount) throw new HttpError(409, 'A message is already processing. Please retry shortly.', undefined, 'NEGOTIATION_COMMAND_IN_PROGRESS');
    let targets = { accountId: identity.customerId };
    try {
      await NegotiationCommand.updateOne(commandFilter, { $set: { status: 'processing', owner }, $unset: { errorCode: 1 } });
      const partner = identity.partnerId ? await HookPartner.findById(identity.partnerId).select('accountId').lean() : null;
      targets = { accountId: partner?.accountId || identity.customerId };
      publishRealtime({ type: 'negotiation.processing', entityId: id, data: { processing: true, requestId: key } }, targets);
      const service = new NegotiationService();
      const result = await withNegotiationExecution(owner, async () => 'offeredPriceMinor' in payload
        ? await service.offer(identity, id, payload.offeredPriceMinor, key, payload.message)
        : await new NegotiationShoppingService().message(identity, id, payload.message || '', key));
      const snapshot = { ...await service.detail(identity, id), processing: false };
      const response = { ...result, ...snapshot, message: result?.message };
      await NegotiationCommand.updateOne({ ...commandFilter, owner }, { $set: { status: 'completed', response } });
      publishRealtime({ type: 'negotiation.messages', entityId: id, version: snapshot.version, data: snapshot }, targets);
      if (identity.partnerId) publishRealtime({ type: 'negotiation.updated', entityId: id }, { accountId: identity.customerId });
      return response;
    } catch (error) {
      await NegotiationCommand.updateOne({ ...commandFilter, owner }, { $set: { status: 'failed', errorCode: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' } });
      throw error;
    } finally {
      await Negotiation.updateOne({ ...filter, 'commandLock.owner': owner }, { $unset: { commandLock: 1 } });
      publishRealtime({ type: 'negotiation.processing', entityId: id, data: { processing: false, requestId: key } }, targets);
    }
  }
}
