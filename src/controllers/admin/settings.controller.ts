import { Request, Response } from 'express';
import { publishConfigChanged } from '@modules/platform/realtime.service';
import { auditAdminAction } from '@lib/audit';
import { sendSuccess } from '@utils/http';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { Product } from '@models/products/product.model';
import { ProductAvailabilityStatus, ProductStatus } from '@lib/constants';
import { publishRealtime } from '@modules/platform/realtime.service';

let settings: Record<string, unknown> = {
  platformName: 'Hook',
  supportEmail: process.env.BREVO_FROM_EMAIL || 'support@hook.local',
  commissionPercentage: 15,
};

export class AdminSettingsController {
  get = async (_req: Request, res: Response) => {
    sendSuccess(res, { ...settings, updatedAt: new Date().toISOString() });
  };

  update = async (req: Request, res: Response) => {
    const { reason, ...fields } = req.body;
    settings = { ...settings, ...fields };
    await auditAdminAction(req, 'settings.update', 'settings', 'platform', { fields: Object.keys(fields), reason });
    publishConfigChanged('commerce');
    sendSuccess(res, { ...settings, updatedAt: new Date().toISOString() });
  };

  catalogAvailability = async (_req: Request, res: Response) => {
    const [commerce, overdueCount] = await Promise.all([
      CommerceSettings.findOne({ key: 'commerce' }).select('catalogAvailabilityCheckDays defaultDeliveryFeeMinor updatedAt updatedBy').lean({ virtuals: true }),
      Product.countDocuments({ availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED, availabilityCheckDueAt: { $lt: new Date() }, deletedAt: { $exists: false } }),
    ]);
    sendSuccess(res, {
      catalogAvailabilityCheckDays: commerce?.catalogAvailabilityCheckDays || 4,
      overdueCount,
      updatedAt: commerce?.updatedAt || null,
      updatedBy: commerce?.updatedBy || null,
    });
  };

  updateCatalogAvailability = async (req: Request, res: Response) => {
    const days = Number(req.body.catalogAvailabilityCheckDays);
    const now = new Date();
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: { catalogAvailabilityCheckDays: days, updatedBy: req.user!.sub } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean({ virtuals: true });
    await Product.updateMany(
      {
        status: ProductStatus.PUBLISHED,
        availabilityStatus: { $in: [ProductAvailabilityStatus.AVAILABLE, ProductAvailabilityStatus.LIMITED] },
        deletedAt: { $exists: false },
      },
      { $set: { availabilityValidUntil: new Date(now.getTime() + days * 24 * 60 * 60 * 1000) } },
    );
    await auditAdminAction(req, 'settings.catalog_availability.updated', 'settings', 'commerce', { catalogAvailabilityCheckDays: days, reason: req.body.reason });
    publishRealtime({ type: 'catalog.updated', entityType: 'home', entityId: 'catalog-availability-policy', version: days }, { public: true, admin: true });
    publishRealtime({ type: 'home.updated', entityType: 'home', entityId: 'catalog-availability-policy', version: days }, { public: true, admin: true });
    sendSuccess(res, { catalogAvailabilityCheckDays: updated?.catalogAvailabilityCheckDays || 4, updatedAt: updated?.updatedAt, updatedBy: updated?.updatedBy });
  };
}
