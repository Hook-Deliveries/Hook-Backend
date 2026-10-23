import { EmailSettings } from '@models/platform/email-settings.model';
import { emailSettingsCache } from '@lib/ttl-cache';

export type ResolvedEmailSettings = {
  supportEmail: string;
  hookOpsEmail: string;
  brevoFromEmail?: string;
  brevoFromName: string;
  appName: string;
  appUrl: string;
  supportUrl: string;
  helpCenterUrl: string;
};

const CACHE_KEY = 'email-settings';

// Admin-editable email settings, DB-backed with env vars as the fallback.
export async function getEmailSettings(): Promise<ResolvedEmailSettings> {
  const cached = emailSettingsCache.get(CACHE_KEY);
  if (cached) return cached;

  const doc = await EmailSettings.findOne({ key: 'email' }).lean();
  const appUrl = (doc?.appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const resolved: ResolvedEmailSettings = {
    supportEmail: doc?.supportEmail || process.env.SUPPORT_EMAIL || process.env.BREVO_FROM_EMAIL || 'support@hook.africa',
    hookOpsEmail: doc?.hookOpsEmail || process.env.HOOK_OPS_EMAIL || process.env.BREVO_FROM_EMAIL || 'ops@hook.africa',
    // Env-only — never DB-backed, so a bad admin edit can't break outgoing mail.
    brevoFromEmail: process.env.BREVO_FROM_EMAIL,
    brevoFromName: process.env.BREVO_FROM_NAME || 'Hook',
    appName: doc?.appName || process.env.APP_NAME || 'Hook',
    appUrl,
    // Our own help center by default; an admin can point this at an external one instead.
    supportUrl: doc?.supportUrl || process.env.SUPPORT_URL || `${appUrl}/help`,
    // Always our own page — order-context deep links rely on its query params staying stable.
    helpCenterUrl: `${appUrl}/help`,
  };
  emailSettingsCache.set(CACHE_KEY, resolved);
  return resolved;
}

export function clearEmailSettingsCache() {
  emailSettingsCache.clear();
}

// Base URL emails link back to; Admin > Settings > Email wins over env vars.
export async function adminAppBaseUrl(): Promise<string> {
  const doc = await EmailSettings.findOne({ key: 'email' }).select('appUrl').lean();
  const url = doc?.appUrl?.trim() || process.env.ADMIN_APP_URL || process.env.APP_URL || 'http://localhost:3000';
  return url.replace(/\/+$/, '');
}
