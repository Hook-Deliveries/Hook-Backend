import { Request, Response } from 'express';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';
import { auditAdminAction } from '@lib/audit';
import { Banner } from '@models/platform/banner.model';
import { publishConfigChanged } from '@modules/platform/realtime.service';

const view = (banner: any) => ({
  id: String(banner._id),
  text: banner.text,
  imageUrl: banner.imageUrl || '',
  linkType: banner.linkType || 'none',
  linkTarget: banner.linkTarget || '',
  placement: banner.placement,
  tone: banner.tone,
  colorBg: banner.colorBg || null,
  colorFg: banner.colorFg || null,
  isActive: banner.isActive,
  sortOrder: banner.sortOrder,
  startsAt: banner.startsAt || null,
  endsAt: banner.endsAt || null,
  updatedAt: banner.updatedAt,
});

export class AdminBannersController {
  list = async (_req: Request, res: Response) => {
    const banners = await Banner.find({ deletedAt: { $exists: false } }).sort({ sortOrder: 1, createdAt: -1 }).lean();
    sendSuccess(res, banners.map(view));
  };

  create = async (req: Request, res: Response) => {
    const banner = await Banner.create({ ...req.body, updatedBy: req.user!.sub });
    await auditAdminAction(req, 'banner.create', 'banner', String(banner._id), { text: banner.text });
    publishConfigChanged('banners');
    sendCreated(res, view(banner.toObject()));
  };

  update = async (req: Request, res: Response) => {
    const banner = await Banner.findOneAndUpdate({ _id: req.params.id, deletedAt: { $exists: false } }, { $set: { ...req.body, updatedBy: req.user!.sub } }, { returnDocument: 'after' }).lean();
    if (!banner) throw new HttpError(404, 'Banner not found');
    await auditAdminAction(req, 'banner.update', 'banner', String(banner._id), { fields: Object.keys(req.body) });
    publishConfigChanged('banners');
    sendSuccess(res, view(banner));
  };

  remove = async (req: Request, res: Response) => {
    const banner = await Banner.findOneAndUpdate({ _id: req.params.id, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } }).lean();
    if (!banner) throw new HttpError(404, 'Banner not found');
    await auditAdminAction(req, 'banner.delete', 'banner', String(banner._id), {});
    publishConfigChanged('banners');
    sendSuccess(res, { deleted: true });
  };

  /** Sets sortOrder from the given order, ten apart — the same scroll order the marquee plays them in. */
  reorder = async (req: Request, res: Response) => {
    const ids: string[] = req.body.ids;
    const rows = await Banner.find({ _id: { $in: ids }, deletedAt: { $exists: false } }).select('_id').lean();
    if (rows.length !== ids.length) throw new HttpError(400, 'One or more banners could not be found', undefined, 'VALIDATION_ERROR');
    await Banner.bulkWrite(ids.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortOrder: (index + 1) * 10 } } },
    })));
    await auditAdminAction(req, 'banner.reorder', 'banner', ids[0], { count: ids.length });
    publishConfigChanged('banners');
    sendSuccess(res, { reordered: ids.length });
  };
}

/** Public: only banners that are on, inside their schedule, for the placement. */
export async function publicBanners(req: Request, res: Response) {
  const placement = req.query.placement === 'category' ? 'category' : 'home';
  const now = new Date();
  const banners = await Banner.find({
    isActive: true,
    deletedAt: { $exists: false },
    placement: { $in: [placement, 'all'] },
    $and: [
      { $or: [{ startsAt: { $exists: false } }, { startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gt: now } }] },
    ],
  }).sort({ sortOrder: 1, createdAt: -1 }).limit(10).lean();
  sendSuccess(res, banners.map((banner: any) => ({ id: String(banner._id), text: banner.text, imageUrl: banner.imageUrl || '', tone: banner.tone, colorBg: banner.colorBg || null, colorFg: banner.colorFg || null, linkType: banner.linkType || 'none', linkTarget: banner.linkTarget || '' })));
}
