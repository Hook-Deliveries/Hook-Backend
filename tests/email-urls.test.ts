import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { EmailSettings } from '../src/models/platform/email-settings.model';
import { adminAppBaseUrl, clearEmailSettingsCache, getEmailSettings, publicWebBaseUrl } from '../src/modules/notifications/email-settings.service';

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  clearEmailSettingsCache();
  delete process.env.PUBLIC_WEB_URL;
  delete process.env.ADMIN_APP_URL;
});

test('customer and portal links are separate settings', async () => {
  await EmailSettings.create({ key: 'email', appUrl: 'https://shop.hook.africa/', portalUrl: 'https://app.hook.africa/' });
  const settings = await getEmailSettings();
  assert.equal(settings.appUrl, 'https://shop.hook.africa');
  assert.equal(settings.portalUrl, 'https://app.hook.africa');
  assert.equal(await adminAppBaseUrl(), 'https://app.hook.africa');
  assert.equal(await publicWebBaseUrl(), 'https://app.hook.africa');
  assert.equal(settings.supportUrl, 'https://app.hook.africa/help');
});

test('without a portal URL the portal falls back to the old single app URL', async () => {
  await EmailSettings.create({ key: 'email', appUrl: 'https://old.hook.africa' });
  assert.equal(await adminAppBaseUrl(), 'https://old.hook.africa');
});
