import { randomUUID } from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { CatalogMediaAsset } from '@models/catalog/catalog.model';
import { HttpError } from '@utils/http';

const supportedFormats = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);

function readiness() {
  const enabled = process.env.CATALOG_SIGNED_MEDIA_ENABLED !== 'false';
  const required = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const;
  const missingConfiguration = required.filter((name) => !process.env[name]);

  return {
    provider: 'cloudinary' as const,
    mode: 'signed' as const,
    enabled,
    configured: missingConfiguration.length === 0,
    available: enabled && missingConfiguration.length === 0,
    maxBytes: Number(process.env.CATALOG_MEDIA_MAX_BYTES || 10 * 1024 * 1024),
    supportedFormats: [...supportedFormats],
  };
}

function configure() {
  const state = readiness();
  if (!state.enabled) {
    throw new HttpError(503, 'Secure catalog media uploads are currently disabled', undefined, 'MEDIA_PROVIDER_UNAVAILABLE');
  }
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new HttpError(503, 'Secure catalog media uploads are temporarily unavailable', undefined, 'MEDIA_PROVIDER_UNAVAILABLE');
  }
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  return { cloudName, apiKey, apiSecret };
}

export class CatalogMediaService {
  readiness() {
    return readiness();
  }

  createIntent(input: {
    accountId: string;
    ownerType: 'submission' | 'product';
    ownerId?: string;
    originalName: string;
    mimeType: string;
    bytes: number;
  }) {
    const { cloudName, apiKey, apiSecret } = configure();
    const maxBytes = Number(process.env.CATALOG_MEDIA_MAX_BYTES || 10 * 1024 * 1024);
    if (input.bytes > maxBytes) {
      throw new HttpError(413, `Image exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit`, undefined, 'VALIDATION_ERROR');
    }
    const uploadIntentId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `${process.env.CLOUDINARY_UPLOAD_FOLDER || 'hook'}/catalog/${input.accountId}`;
    const publicId = `${uploadIntentId}-${input.originalName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 80)}`;
    const params = {
      folder,
      public_id: publicId,
      timestamp,
      type: 'authenticated',
    };
    return {
      uploadIntentId,
      cloudName,
      apiKey,
      timestamp,
      folder,
      publicId,
      type: 'authenticated',
      signature: cloudinary.utils.api_sign_request(params, apiSecret),
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
    };
  }

  async finalize(input: {
    accountId: string;
    uploadIntentId: string;
    providerPublicId: string;
    version: string;
    ownerType: 'submission' | 'product';
    ownerId?: string;
  }) {
    configure();
    const existing = await CatalogMediaAsset.findOne({ uploadIntentId: input.uploadIntentId }).lean({ virtuals: true });
    if (existing) {
      if (existing.uploaderAccountId !== input.accountId) {
        throw new HttpError(404, 'Media upload was not found', undefined, 'NOT_FOUND');
      }
      return existing;
    }
    const expectedFolder = `${process.env.CLOUDINARY_UPLOAD_FOLDER || 'hook'}/catalog/${input.accountId}/`;
    if (!input.providerPublicId.startsWith(expectedFolder)) {
      throw new HttpError(403, 'Uploaded media does not belong to this account', undefined, 'ACCESS_DENIED');
    }
    let resource: any;
    try {
      resource = await cloudinary.api.resource(input.providerPublicId, {
        resource_type: 'image',
        type: 'authenticated',
      });
    } catch {
      throw new HttpError(400, 'Cloudinary could not verify this upload', undefined, 'VALIDATION_ERROR');
    }
    const maxBytes = Number(process.env.CATALOG_MEDIA_MAX_BYTES || 10 * 1024 * 1024);
    if (
      resource.resource_type !== 'image'
      || !supportedFormats.has(String(resource.format || '').toLowerCase())
      || Number(resource.bytes || 0) > maxBytes
      || Number(resource.width || 0) < 320
      || Number(resource.height || 0) < 320
    ) {
      throw new HttpError(400, 'Uploaded image does not meet catalog media requirements', undefined, 'VALIDATION_ERROR');
    }
    return CatalogMediaAsset.create({
      publicId: `MED-${input.uploadIntentId}`,
      provider: 'cloudinary',
      providerPublicId: input.providerPublicId,
      resourceType: 'image',
      deliveryType: 'authenticated',
      format: resource.format,
      width: resource.width,
      height: resource.height,
      bytes: resource.bytes,
      uploaderAccountId: input.accountId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      uploadIntentId: input.uploadIntentId,
      status: 'ready',
      order: 0,
      metadata: { version: input.version, originalFilename: resource.original_filename },
    });
  }

  deliveryUrl(asset: { providerPublicId: string; format: string; deliveryType: string }) {
    configure();
    if (asset.deliveryType === 'external') return undefined;
    return cloudinary.url(asset.providerPublicId, {
      type: asset.deliveryType,
      resource_type: 'image',
      format: asset.format,
      sign_url: true,
      secure: true,
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });
  }
}
