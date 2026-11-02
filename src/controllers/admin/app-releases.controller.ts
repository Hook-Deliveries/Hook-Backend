import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AppRelease } from '@models/platform/app-release.model';
import { appReleaseDecision, compareAppBuild, compareNumericVersion, validStoreUrl, appReleaseSchema, versionAnnouncementSchema, HOOK_PLAY_STORE_URL } from '@lib/app-release-policy';
import { HttpError, sendSuccess, sendCreated } from '@utils/http';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { publishRealtime } from '@modules/platform/realtime.service';
import { routeParam } from '@lib/api-utils';
import { z } from 'zod';

export class AppReleasesController {
  list = async (_req: Request, res: Response) => {
    sendSuccess(res, await AppRelease.find().sort({ createdAt: -1 }).limit(100).lean({ virtuals: true }));
  };
  create = async (req: Request, res: Response) => {
    if (!('platform' in req.body)) {
      const input = versionAnnouncementSchema.parse(req.body);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const active = await AppRelease.find({ status: 'published' }).session(session).lean();
          if (active.some((release) => compareNumericVersion(input.version, release.version) <= 0)) throw new HttpError(409, 'Enter a version newer than the currently announced version');
          await AppRelease.updateMany({ status: 'published' }, { $set: { status: 'withdrawn', updatedBy: req.user!.sub }, $inc: { revision: 1 } }, { session });
          await AppRelease.create((['android', 'ios'] as const).map((platform) => ({
            platform, version: input.version, build: '0', minimumVersion: '0', minimumBuild: '0',
            releaseNotes: input.releaseNotes || 'A new Hook update is available. Update to enjoy the latest improvements.',
            storeUrl: platform === 'android' ? HOOK_PLAY_STORE_URL : '', status: 'published',
            publishedAt: new Date(), updatedBy: req.user!.sub,
          })), { session, ordered: true });
        });
      } finally { await session.endSession(); }
      await recordAudit(req, { action: 'app_release.published', entityType: 'app_release', after: { version: input.version, platforms: ['android', 'ios'] } });
      publishRealtime({ type: 'app-release.updated' }, { public: true });
      sendCreated(res, { version: input.version, message: 'Update announced to Android and iOS users' });
      return;
    }
    const input = appReleaseSchema.parse(req.body);
    if (input.storeUrl && !validStoreUrl(input.platform, input.storeUrl)) throw new HttpError(400, 'Store URL must match the configured Hook store listing');
    if (compareAppBuild({ version: input.minimumVersion, build: input.minimumBuild }, input) > 0) throw new HttpError(400, 'Minimum supported build cannot exceed this release');
    const release = await AppRelease.create({ ...input, status: 'draft', updatedBy: req.user!.sub });
    await recordAudit(req, { action: 'app_release.drafted', entityType: 'app_release', entityPublicId: release.id, after: { platform: input.platform, version: input.version, build: input.build } });
    sendCreated(res, release);
  };
  publish = async (req: Request, res: Response) => {
    if (req.body.storeAvailable !== true) throw new HttpError(400, 'Confirm this build is available to all intended store users');
    const id = routeParam(req.params.id);
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Release not found');
    const release = await AppRelease.findById(id).lean();
    if (!release || release.status !== 'draft') throw new HttpError(409, 'Only draft releases can be published');
    if (!validStoreUrl(release.platform, release.storeUrl)) throw new HttpError(400, 'Store URL must match the configured Hook store listing');
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await AppRelease.updateMany({ platform: release.platform, status: 'published' }, { $set: { status: 'withdrawn', updatedBy: req.user!.sub }, $inc: { revision: 1 } }, { session });
        const updated = await AppRelease.updateOne({ _id: id, status: 'draft', revision: release.revision }, { $set: { status: 'published', publishedAt: new Date(), updatedBy: req.user!.sub }, $inc: { revision: 1 } }, { session });
        if (!updated.modifiedCount) throw new HttpError(409, 'Release changed; refresh and retry');
      });
    } finally { await session.endSession(); }
    await recordAudit(req, { action: 'app_release.published', entityType: 'app_release', entityPublicId: id, after: { platform: release.platform, version: release.version, build: release.build } });
    publishRealtime({ type: 'app-release.updated', entityId: id }, { public: true });
    sendSuccess(res, { message: 'Release published' });
  };
  withdraw = async (req: Request, res: Response) => {
    const id = routeParam(req.params.id);
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Release not found');
    const updated = await AppRelease.updateOne({ _id: id, status: { $ne: 'withdrawn' } }, { $set: { status: 'withdrawn', updatedBy: req.user!.sub }, $inc: { revision: 1 } });
    if (!updated.modifiedCount) throw new HttpError(409, 'Release is missing or already withdrawn');
    await recordAudit(req, { action: 'app_release.withdrawn', entityType: 'app_release', entityPublicId: id });
    publishRealtime({ type: 'app-release.updated', entityId: id }, { public: true });
    sendSuccess(res, { message: 'Release withdrawn' });
  };
  publicPolicy = async (req: Request, res: Response) => {
    const query = z.object({ platform: z.enum(['android', 'ios']), version: z.string().regex(/^\d{1,9}(?:\.\d{1,9}){0,2}$/), build: z.string().regex(/^\d{1,9}(?:\.\d{1,9}){0,2}$/) }).safeParse(req.query);
    if (!query.success) throw new HttpError(400, 'Valid platform, installed version and build are required');
    const release = await AppRelease.findOne({ platform: query.data.platform, status: 'published' }).lean();
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { release: release ? { id: release._id.toString(), platform: release.platform, version: release.version, build: release.build, minimumVersion: release.minimumVersion, minimumBuild: release.minimumBuild, releaseNotes: release.releaseNotes, storeUrl: release.storeUrl } : null, ...appReleaseDecision(release, query.data) });
  };
}
