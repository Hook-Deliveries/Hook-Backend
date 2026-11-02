import { BaseEntity, createModel, createSchema } from "@models/base.model";

/**
 * Operational record of an outbox event that exhausted its retries. The outbox
 * row itself stays `dead_letter`; this document is what admins inspect and
 * re-drive, and it never stores payloads or raw provider responses.
 */
export interface DeadLetterEvent extends BaseEntity {
  outboxPublicId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  sanitizedError: string;
  firstFailedAt: Date;
  lastFailedAt: Date;
  replayStatus: "pending" | "replayed";
  replayCount: number;
  replayedBy?: string;
  replayedAt?: Date;
}

const deadLetterSchema = createSchema<DeadLetterEvent>({
  outboxPublicId: { type: String, required: true, unique: true },
  eventType: { type: String, required: true, index: true },
  aggregateType: { type: String, required: true },
  aggregateId: { type: String, required: true, index: true },
  attempts: { type: Number, default: 0 },
  sanitizedError: { type: String, default: "", maxlength: 500 },
  firstFailedAt: { type: Date, required: true },
  lastFailedAt: { type: Date, required: true },
  replayStatus: { type: String, enum: ["pending", "replayed"], default: "pending", index: true },
  replayCount: { type: Number, default: 0 },
  replayedBy: { type: String },
  replayedAt: { type: Date },
});
deadLetterSchema.index({ replayStatus: 1, lastFailedAt: -1 });

export const DeadLetterEvent = createModel<DeadLetterEvent>("DeadLetterEvent", deadLetterSchema);
