import { BaseEntity, createModel, createSchema } from "@models/base.model";

export const OUTBOX_EVENT_TYPES = [
  "ORDER_APPROVED_FOR_FULFILMENT",
  "PAYMENT_CONFIRMED_EFFECTS",
  "ORDER_CREATED_EFFECTS",
  "REFUND_PROCESSED_EFFECTS",
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface CommerceOutboxEvent extends BaseEntity {
  publicId: string;
  aggregateType: "order" | "payment" | "refund";
  aggregateId: string;
  eventType: OutboxEventType;
  eventVersion: number;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "published" | "dead_letter";
  attempts: number;
  availableAt: Date;
  processedAt?: Date;
  lastError?: string;
  firstFailedAt?: Date;
  lockedUntil?: Date;
  lockToken?: string;
  dispatchedAt?: Date;
}

const outboxSchema = createSchema<CommerceOutboxEvent>({
  publicId: { type: String, required: true, unique: true, index: true },
  aggregateType: { type: String, enum: ["order", "payment", "refund"], default: "order" },
  aggregateId: { type: String, required: true, index: true },
  eventType: {
    type: String,
    enum: [...OUTBOX_EVENT_TYPES],
    required: true,
  },
  eventVersion: { type: Number, default: 1 },
  payload: { type: Object, required: true },
  status: {
    type: String,
    enum: ["pending", "processing", "published", "dead_letter"],
    default: "pending",
    index: true,
  },
  attempts: { type: Number, default: 0 },
  availableAt: { type: Date, default: Date.now, index: true },
  processedAt: { type: Date },
  lastError: { type: String, maxlength: 1000 },
  firstFailedAt: { type: Date },
  lockedUntil: { type: Date, index: true },
  lockToken: { type: String, index: true, sparse: true },
  dispatchedAt: { type: Date },
  deletedAt: { type: Date },
});
outboxSchema.index(
  { aggregateId: 1, eventType: 1, eventVersion: 1 },
  { unique: true },
);
export const CommerceOutboxEvent = createModel<CommerceOutboxEvent>(
  "CommerceOutboxEvent",
  outboxSchema,
);
