import { BaseEntity, createModel, createSchema } from "@models/base.model";

export interface IdempotencyRecord extends BaseEntity {
  actorKey: string;
  operation: string;
  key: string;
  requestHash: string;
  state: "in_progress" | "completed";
  statusCode?: number;
  responseBody?: unknown;
  lockedUntil: Date;
  expiresAt: Date;
}

const idempotencySchema = createSchema<IdempotencyRecord>({
  actorKey: { type: String, required: true },
  operation: { type: String, required: true },
  key: { type: String, required: true },
  requestHash: { type: String, required: true },
  state: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },
  statusCode: { type: Number },
  responseBody: { type: Object },
  lockedUntil: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
idempotencySchema.index({ actorKey: 1, operation: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecord = createModel<IdempotencyRecord>("IdempotencyRecord", idempotencySchema);
