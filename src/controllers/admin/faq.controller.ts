import { Request, Response } from 'express';
import { Faq } from '@models/platform/faq.model';
import { nextPublicId } from '@modules/platform/public-id.service';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { routeParam } from '@lib/api-utils';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';

export class AdminFaqController {
  list = async (_req: Request, res: Response) => {
    const data = await Faq.find().sort({ order: 1, createdAt: 1 }).lean();
    sendSuccess(res, { data });
  };

  create = async (req: Request, res: Response) => {
    const faq = await Faq.create({
      publicId: await nextPublicId('faq'),
      question: req.body.question,
      answer: req.body.answer,
      order: req.body.order ?? (await Faq.countDocuments()),
      isActive: req.body.isActive ?? true,
      updatedBy: req.user!.sub,
    });
    await recordAudit(req, { action: 'faq.created', entityType: 'faq', entityId: faq.id, entityPublicId: faq.publicId, after: faq.toObject() });
    sendCreated(res, faq.toObject());
  };

  update = async (req: Request, res: Response) => {
    const identifier = routeParam(req.params.id);
    const faq = await Faq.findOne({ publicId: identifier });
    if (!faq) throw new HttpError(404, 'FAQ not found', undefined, 'NOT_FOUND');
    const before = faq.toObject();
    Object.assign(faq, { ...req.body, updatedBy: req.user!.sub });
    await faq.save();
    await recordAudit(req, { action: 'faq.updated', entityType: 'faq', entityId: faq.id, entityPublicId: faq.publicId, before, after: faq.toObject() });
    sendSuccess(res, faq.toObject());
  };

  remove = async (req: Request, res: Response) => {
    const identifier = routeParam(req.params.id);
    const faq = await Faq.findOneAndDelete({ publicId: identifier });
    if (!faq) throw new HttpError(404, 'FAQ not found', undefined, 'NOT_FOUND');
    await recordAudit(req, { action: 'faq.deleted', entityType: 'faq', entityId: faq.id, entityPublicId: faq.publicId, before: faq.toObject() });
    sendSuccess(res, { deleted: true });
  };
}
