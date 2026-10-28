import { Request, Response } from 'express';
import { CatalogMediaService } from '@modules/catalog/catalog-media.service';
import { sendCreated, sendSuccess } from '@utils/http';

export class CatalogMediaController {
  private readonly media = new CatalogMediaService();

  readiness = async (_req: Request, res: Response) => {
    sendSuccess(res, this.media.readiness());
  };

  intent = async (req: Request, res: Response) => {
    sendCreated(res, this.media.createIntent({
      accountId: req.user!.sub,
      ...req.body,
    }));
  };

  finalize = async (req: Request, res: Response) => {
    const asset = await this.media.finalize({
      accountId: req.user!.sub,
      ...req.body,
    });
    const value = typeof (asset as any).toJSON === 'function' ? (asset as any).toJSON() : asset;
    sendSuccess(res, {
      ...value,
      deliveryUrl: this.media.deliveryUrl(value),
    });
  };
}
