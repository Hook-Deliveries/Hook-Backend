import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAppBuild, appReleaseDecision, appReleaseSchema, validStoreUrl, versionAnnouncementSchema } from '../src/lib/app-release-policy';
const release = { platform: 'android' as const, version: '1.10.0', build: '20', minimumVersion: '1.2.0', minimumBuild: '3', storeUrl: 'https://play.google.com/store/apps/details?id=com.biodun42.hook', releaseNotes: 'Improvements' };
test('versions and builds compare numerically, not lexically', () => {
  assert.equal(compareAppBuild({ version: '1.9.0', build: '999' }, release), -1);
  assert.equal(compareAppBuild({ version: '1.10', build: '9' }, release), -1);
  assert.equal(compareAppBuild({ version: '1.10.0', build: '20' }, release), 0);
});
test('latest is optional, below minimum is required, newer builds need no update', () => {
  assert.deepEqual(appReleaseDecision(release, { version: '1.9', build: '9' }), { updateAvailable: true, required: false });
  assert.deepEqual(appReleaseDecision(release, { version: '1.2', build: '2' }), { updateAvailable: true, required: true });
  assert.deepEqual(appReleaseDecision(release, { version: '2.0', build: '1' }), { updateAvailable: false, required: false });
  assert.deepEqual(appReleaseDecision(null, { version: '1', build: '1' }), { updateAvailable: false, required: false });
});
test('store links cannot redirect users to another app or host', () => {
  assert.equal(validStoreUrl('android', release.storeUrl), true);
  for (const bad of ['https://play.google.com.evil.test/store/apps/details?id=com.biodun42.hook', 'https://play.google.com/store/apps/details?id=another.app', 'javascript:alert(1)', `${release.storeUrl}&redirect=https://evil.test`]) assert.equal(validStoreUrl('android', bad), false);
  const ios = 'https://apps.apple.com/ng/app/hook/id123456789';
  assert.equal(validStoreUrl('ios', ios), true);
  assert.equal(validStoreUrl('ios', 'https://apps.apple.com.evil.test/ng/app/hook/id987654321'), false);
});
test('version announcements require only a version and never force an update', () => {
  assert.equal(versionAnnouncementSchema.safeParse({ version: '1.11.0' }).success, true);
  assert.equal(versionAnnouncementSchema.safeParse({ version: 'latest' }).success, false);
  assert.equal(versionAnnouncementSchema.safeParse({ version: '1.11.0', storeUrl: 'javascript:alert(1)' }).success, false);
  const announcement = { ...release, version: '1.11.0', build: '0', minimumVersion: '0', minimumBuild: '0' };
  assert.deepEqual(appReleaseDecision(announcement, { version: '1.10', build: '20' }), { updateAvailable: true, required: false });
  assert.deepEqual(appReleaseDecision(announcement, { version: '1.11', build: '20' }), { updateAvailable: false, required: false });
});
test('release schema rejects malformed versions and unknown fields', () => {
  assert.equal(appReleaseSchema.safeParse(release).success, true);
  assert.equal(appReleaseSchema.safeParse({ ...release, version: 'latest' }).success, false);
  assert.equal(appReleaseSchema.safeParse({ ...release, approvedPrice: 1 }).success, false);
});
