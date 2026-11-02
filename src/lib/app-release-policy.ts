import { z } from 'zod';
const numericVersion = z.string().trim().regex(/^\d{1,9}(?:\.\d{1,9}){0,2}$/);
export const versionAnnouncementSchema = z.object({ version: numericVersion, releaseNotes: z.string().trim().max(4000).optional() }).strict();
export const HOOK_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.biodun42.hook';
export const appReleaseSchema = z.object({
  platform: z.enum(['android', 'ios']), version: numericVersion, build: numericVersion,
  minimumVersion: numericVersion, minimumBuild: numericVersion,
  releaseNotes: z.string().trim().min(1).max(4000), storeUrl: z.string().trim().max(1000),
}).strict();
export type AppReleaseInput = z.infer<typeof appReleaseSchema>;
export function compareNumericVersion(a: string, b: string) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
export function compareAppBuild(a: { version: string; build: string }, b: { version: string; build: string }) {
  return compareNumericVersion(a.version, b.version) || compareNumericVersion(a.build, b.build);
}
export function appReleaseDecision(release: AppReleaseInput | null, installed: { version: string; build: string }) {
  return { updateAvailable: Boolean(release && compareAppBuild(installed, release) < 0),
    required: Boolean(release && compareAppBuild(installed, { version: release.minimumVersion, build: release.minimumBuild }) < 0) };
}
export function validStoreUrl(platform: 'android' | 'ios', raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return false;
    if (platform === 'android') return url.hostname === 'play.google.com' && url.pathname === '/store/apps/details' && url.searchParams.get('id') === 'com.biodun42.hook' && [...url.searchParams.keys()].every((key) => key === 'id');
    return Boolean(url.hostname === 'apps.apple.com' && /\/id\d+$/.test(url.pathname) && !url.search);
  } catch { return false; }
}
