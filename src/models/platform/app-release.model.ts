import { BaseEntity, createModel, createSchema } from '@models/base.model';
import type { AppReleaseInput } from '@lib/app-release-policy';
export interface AppRelease extends BaseEntity, AppReleaseInput {
  status: 'draft' | 'published' | 'withdrawn'; publishedAt?: Date; updatedBy: string; revision: number;
}
const schema = createSchema<AppRelease>({
  platform: { type: String, enum: ['android', 'ios'], required: true },
  version: { type: String, required: true }, build: { type: String, required: true },
  minimumVersion: { type: String, required: true }, minimumBuild: { type: String, required: true },
  releaseNotes: { type: String, required: true }, storeUrl: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'published', 'withdrawn'], default: 'draft' },
  publishedAt: Date, updatedBy: { type: String, required: true }, revision: { type: Number, default: 1 },
});
schema.index({ platform: 1 }, { unique: true, partialFilterExpression: { status: 'published' } });
export const AppRelease = createModel<AppRelease>('AppRelease', schema);
