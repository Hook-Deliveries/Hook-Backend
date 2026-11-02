import { HttpError } from '@utils/http';
import { v2 as cloudinary } from 'cloudinary';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface MediaAsset {
  url: string;
  secureUrl: string;
  publicId?: string;
  source: 'cloudinary' | 'external';
  width?: number;
  height?: number;
  format?: string;
  size?: number;
  originalName?: string;
  mimetype?: string;
}

interface CloudinaryUploadResponse {
  secure_url?: string;
  url?: string;
  public_id?: string;
  width?: number;
  height?: number;
  format?: string;
  bytes?: number;
  resource_type?: string;
  error?: { message?: string };
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
  }
  return false;
}

function cloudName() {
  return process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
}

function uploadPreset() {
  return process.env.CLOUDINARY_UPLOAD_PRESET || process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET;
}

function assertCloudinaryConfig() {
  if (!cloudName() || !uploadPreset()) {
    throw new HttpError(500, 'Cloudinary upload is not configured');
  }
}

function parseImageUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, `Invalid image URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, 'Image URL must start with http or https');
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || isPrivateAddress(host)) {
    throw new HttpError(400, 'Private or internal image URLs are not allowed');
  }
  return parsed;
}

async function assertPublicImageUrl(value: string) {
  const parsed = parseImageUrl(value);
  try {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new HttpError(400, 'Private or internal image URLs are not allowed');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The image host could not be reached');
  }
}

function parseCloudinaryAsset(payload: CloudinaryUploadResponse, file?: Express.Multer.File): MediaAsset {
  if (payload.error?.message) throw new HttpError(502, payload.error.message);
  if (payload.resource_type && payload.resource_type !== 'image') throw new HttpError(400, 'Only image uploads are allowed');
  const secureUrl = payload.secure_url || payload.url;
  if (!secureUrl) throw new HttpError(502, 'Cloudinary did not return an image URL');
  return {
    url: secureUrl,
    secureUrl,
    publicId: payload.public_id,
    source: 'cloudinary',
    width: payload.width,
    height: payload.height,
    format: payload.format,
    size: payload.bytes || file?.size,
    originalName: file?.originalname,
    mimetype: file?.mimetype,
  };
}

export class MediaService {
  async uploadImage(file: Express.Multer.File): Promise<MediaAsset> {
    const cloud = cloudName();
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (cloud && apiKey && apiSecret) {
      cloudinary.config({ cloud_name: cloud, api_key: apiKey, api_secret: apiSecret, secure: true });
      const payload = await new Promise<CloudinaryUploadResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: process.env.CLOUDINARY_UPLOAD_FOLDER || 'hook', resource_type: 'image' },
          (error, result) => error || !result ? reject(error || new Error('Cloudinary upload failed')) : resolve(result),
        );
        stream.end(file.buffer);
      });
      return parseCloudinaryAsset(payload, file);
    }
    assertCloudinaryConfig();
    const body = new FormData();
    const blob = new Blob([file.buffer as BlobPart], { type: file.mimetype });
    body.append('file', blob, file.originalname);
    body.append('upload_preset', uploadPreset() as string);
    body.append('folder', process.env.CLOUDINARY_UPLOAD_FOLDER || 'hook');

    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName()}/image/upload`, {
      method: 'POST',
      body,
    });
    const payload = (await response.json()) as CloudinaryUploadResponse;
    if (!response.ok) {
      throw new HttpError(response.status >= 500 ? 502 : 400, payload.error?.message || 'Cloudinary upload failed');
    }
    return parseCloudinaryAsset(payload, file);
  }

  async uploadRemoteImage(url: string): Promise<MediaAsset> {
    const cleanUrl = url.trim();
    await assertPublicImageUrl(cleanUrl);
    const cloud = cloudName();
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (cloud && apiKey && apiSecret) {
      cloudinary.config({ cloud_name: cloud, api_key: apiKey, api_secret: apiSecret, secure: true });
      const payload = await cloudinary.uploader.upload(cleanUrl, {
        folder: process.env.CLOUDINARY_UPLOAD_FOLDER || 'hook',
        resource_type: 'image',
      }) as CloudinaryUploadResponse;
      return parseCloudinaryAsset(payload);
    }

    assertCloudinaryConfig();
    const body = new FormData();
    body.append('file', cleanUrl);
    body.append('upload_preset', uploadPreset() as string);
    body.append('folder', process.env.CLOUDINARY_UPLOAD_FOLDER || 'hook');
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName()}/image/upload`, { method: 'POST', body });
    const payload = (await response.json()) as CloudinaryUploadResponse;
    if (!response.ok) {
      throw new HttpError(response.status >= 500 ? 502 : 400, payload.error?.message || 'Cloudinary could not import this image');
    }
    return parseCloudinaryAsset(payload);
  }

  fromExternalUrl(url: string): MediaAsset {
    const cleanUrl = url.trim();
    parseImageUrl(cleanUrl);
    return {
      url: cleanUrl,
      secureUrl: cleanUrl,
      source: 'external',
    };
  }

  async normalize(files: Express.Multer.File[], urls: string[] = []): Promise<MediaAsset[]> {
    const [uploaded, imported] = await Promise.all([
      Promise.all(files.map((file) => this.uploadImage(file))),
      Promise.all(urls.filter(Boolean).map((url) => this.uploadRemoteImage(url))),
    ]);
    return [...uploaded, ...imported];
  }
}
