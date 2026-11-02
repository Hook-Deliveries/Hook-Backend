import { Request, Response } from 'express';
import { publishConfigChanged } from '@modules/platform/realtime.service';
import mongoose from 'mongoose';
import { LegalContent } from '@models/platform/legal-content.model';
import { CommercePolicyVersion, CommerceSettings } from '@models/commerce/commerce.model';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { routeParam } from '@lib/api-utils';
import { HttpError, sendSuccess } from '@utils/http';
import { DEFAULT_RETURNS_POLICY_HTML } from '@lib/legal-defaults';

const DEFAULT_TITLES: Record<string, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  returns: 'Returns Policy',
};

type LegalSnapshot = {
  title?: string;
  bodyHtml?: string;
  version?: number;
  effectiveDate?: Date;
  updatedAt?: Date;
};

function assertType(type: string): asserts type is 'terms' | 'privacy' | 'returns' {
  if (type !== 'terms' && type !== 'privacy' && type !== 'returns') {
    throw new HttpError(404, 'Unknown legal document type', undefined, 'NOT_FOUND');
  }
}

export class AdminLegalContentController {
  get = async (req: Request, res: Response) => {
    const type = routeParam(req.params.type);
    assertType(type);
    const doc = await LegalContent.findOne({ type }).lean();
    sendSuccess(res, {
      type,
      title: doc?.title || DEFAULT_TITLES[type],
      bodyHtml: doc?.bodyHtml || (type === 'returns' ? DEFAULT_RETURNS_POLICY_HTML : ''),
      version: doc?.version || 0,
      effectiveDate: doc?.effectiveDate || null,
      updatedAt: doc?.updatedAt || null,
    });
  };

  update = async (req: Request, res: Response) => {
    const type = routeParam(req.params.type);
    assertType(type);
    const session = await mongoose.startSession();
    const snapshots: { existing: LegalSnapshot | null; updated: LegalSnapshot | null } = {
      existing: null,
      updated: null,
    };
    try {
      await session.withTransaction(async () => {
        snapshots.existing = await LegalContent.findOne({ type }).session(session).lean();
        const version = (snapshots.existing?.version || 0) + 1;
        const effectiveDate = req.body.effectiveDate ? new Date(req.body.effectiveDate) : new Date();
        snapshots.updated = await LegalContent.findOneAndUpdate(
          { type },
          {
            $set: {
              title: req.body.title || DEFAULT_TITLES[type],
              bodyHtml: req.body.bodyHtml,
              effectiveDate,
              version,
              updatedBy: req.user!.sub,
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, session },
        ).lean();

        const commerceType = type.toUpperCase() as 'TERMS' | 'PRIVACY' | 'RETURNS';
        await CommercePolicyVersion.updateMany(
          { type: commerceType, status: 'active' },
          { $set: { status: 'retired' } },
          { session },
        );
        await CommercePolicyVersion.findOneAndUpdate(
          { type: commerceType, version: String(version) },
          {
            $set: {
              status: 'active',
              effectiveAt: effectiveDate,
              contentUrl: `/${type}`,
            },
            $setOnInsert: { publicId: `POL-${commerceType}-${version}` },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, session },
        );
        await CommerceSettings.findOneAndUpdate(
          { key: 'commerce' },
          {
            $set: {
              [`activePolicyVersions.${commerceType}`]: String(version),
              updatedBy: req.user!.sub,
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, session },
        );
      });
    } finally {
      await session.endSession();
    }
    await recordAudit(req, {
      action: 'legal_content.update',
      entityType: 'legal_content',
      entityId: type,
      before: snapshots.existing || undefined,
      after: snapshots.updated || undefined,
      reason: req.body.reason,
    });
    publishConfigChanged('legal');
    sendSuccess(res, {
      type,
      title: snapshots.updated?.title,
      bodyHtml: snapshots.updated?.bodyHtml,
      version: snapshots.updated?.version,
      effectiveDate: snapshots.updated?.effectiveDate,
      updatedAt: snapshots.updated?.updatedAt,
    });
  };
}
