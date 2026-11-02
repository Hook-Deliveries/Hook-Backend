import { Request, Response } from 'express';
import { MediaService } from '@modules/catalog/media.service';
import { HttpError, sendCreated } from '@utils/http';

export class UploadController {
  private readonly media = new MediaService();

  image = async (req: Request, res: Response) => {
    const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl : undefined;
    const assets = await this.media.normalize(req.file ? [req.file] : [], imageUrl ? [imageUrl] : []);
    if (!assets.length) throw new HttpError(400, 'Image file or imageUrl is required');
    sendCreated(res, assets[0]);
  };

  images = async (req: Request, res: Response) => {
    const files = (req.files || []) as Express.Multer.File[];
    const rawUrls = req.body.imageUrls || req.body.images || [];
    const imageUrls = Array.isArray(rawUrls)
      ? rawUrls
      : String(rawUrls || '').split(',').map((item) => item.trim()).filter(Boolean);
    const assets = await this.media.normalize(files, imageUrls);
    if (!assets.length) throw new HttpError(400, 'At least one image file or image URL is required');
    sendCreated(res, assets);
  };
}
