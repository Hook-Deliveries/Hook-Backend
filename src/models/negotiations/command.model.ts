import { BaseEntity, createModel, createSchema } from '@models/base.model';
export interface NegotiationCommand extends BaseEntity {
  negotiationId: string; actorId: string; key: string; hash: string;
  status: 'pending' | 'processing' | 'failed' | 'completed'; owner?: string;
  response?: Record<string, unknown>; errorCode?: string;
}
const schema = createSchema<NegotiationCommand>({
  negotiationId: { type: String, required: true }, actorId: { type: String, required: true },
  key: { type: String, required: true }, hash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'failed', 'completed'], required: true },
  owner: String, response: Object, errorCode: String,
});
schema.index({ negotiationId: 1, actorId: 1, key: 1 }, { unique: true });
export const NegotiationCommand = createModel<NegotiationCommand>('NegotiationCommand', schema);
