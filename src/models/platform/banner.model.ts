import { BaseEntity, createModel, createSchema } from '@models/base.model';

export type BannerPlacement = 'home' | 'category' | 'all';
export type BannerTone = 'gold' | 'dark' | 'green' | 'red';

/** One message in the scrolling banner strip shown in the customer app. */
export interface Banner extends BaseEntity {
  text: string;
  /** Optional picture shown beside the message. */
  imageUrl?: string;
  /** Optional in-app destination, e.g. a category or product screen. */
  linkType?: 'category' | 'product' | 'market' | 'none';
  linkTarget?: string;
  placement: BannerPlacement;
  tone: BannerTone;
  /** A custom colour instead of one of the four fixed tones. When set, these win over `tone` at render time. */
  colorBg?: string;
  colorFg?: string;
  isActive: boolean;
  sortOrder: number;
  startsAt?: Date;
  endsAt?: Date;
  updatedBy?: string;
}

const bannerSchema = createSchema<Banner>({
  text: { type: String, required: true, trim: true, maxlength: 140 },
  imageUrl: { type: String, trim: true },
  linkType: { type: String, enum: ['category', 'product', 'market', 'none'], default: 'none' },
  linkTarget: { type: String, trim: true },
  placement: { type: String, enum: ['home', 'category', 'all'], default: 'home', index: true },
  tone: { type: String, enum: ['gold', 'dark', 'green', 'red'], default: 'gold' },
  colorBg: { type: String, trim: true },
  colorFg: { type: String, trim: true },
  isActive: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
  startsAt: { type: Date },
  endsAt: { type: Date },
  updatedBy: { type: String },
  deletedAt: { type: Date },
});

export const Banner = createModel<Banner>('Banner', bannerSchema);
