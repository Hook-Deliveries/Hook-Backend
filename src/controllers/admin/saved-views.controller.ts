import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';
import { AdminSavedView } from '@models/admin/saved-view.model';
import { UserRole } from '@lib/constants';
import { routeParam } from './admin.helpers';

export class AdminSavedViewsController {
  list = async (req: Request, res: Response) => {
    const page = String(req.query.page || '');
    if (!page) throw new HttpError(400, 'page is required', undefined, 'VALIDATION_ERROR');
    const views = await AdminSavedView.find({ adminUserId: req.user!.sub, page, deletedAt: { $exists: false } })
      .sort({ createdAt: 1 })
      .select('publicId name params createdAt')
      .lean();
    sendSuccess(res, { data: views });
  };

  create = async (req: Request, res: Response) => {
    const view = await AdminSavedView.create({
      publicId: randomUUID(),
      adminUserId: req.user!.sub,
      page: req.body.page,
      name: req.body.name,
      params: req.body.params,
    });
    sendCreated(res, { publicId: view.publicId, name: view.name, params: view.params });
  };

  remove = async (req: Request, res: Response) => {
    const view = await AdminSavedView.findOne({ publicId: routeParam(req.params.id) });
    if (!view) throw new HttpError(404, 'Saved view not found');
    // A super admin may clean up anyone's saved view; otherwise it's private to whoever created it.
    if (view.adminUserId !== req.user!.sub && req.user!.role !== UserRole.SUPER_ADMIN)
      throw new HttpError(403, 'You can only remove your own saved views');
    view.deletedAt = new Date();
    await view.save();
    sendSuccess(res, { removed: true });
  };
}
