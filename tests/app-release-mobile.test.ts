import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const skip = existsSync(join(__dirname, '../../Hook-App/lib')) ? false : 'needs the Hook-App repo checked out next to Hook-Backend';
const { hookPlayStoreUrl, resolveHookAppStoreUrl } = skip ? ({} as any) : require('../../Hook-App/lib/app-store-link');
const { parseStoreRelease, storeUpdateDecision } = skip ? ({} as any) : require('../../Hook-App/lib/app-release-policy');

test('version-only announcements work on iOS without a configured URL', { skip }, () => {
  const release = parseStoreRelease({ id: 'release', platform: 'ios', version: '1.2.0', build: '0', minimumVersion: '0', minimumBuild: '0', releaseNotes: 'New update', storeUrl: '' });
  assert.ok(release);
  assert.deepEqual(storeUpdateDecision(release, { version: '1.1', build: '100' }), { available: true, required: false });
  assert.deepEqual(storeUpdateDecision(release, { version: '1.2', build: '100' }), { available: false, required: false });
  assert.equal(hookPlayStoreUrl, 'https://play.google.com/store/apps/details?id=com.biodun42.hook');
});
test('Apple lookup opens only the matching Hook bundle and a genuine Apple host', { skip }, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ results: [
    { bundleId: 'another.hook', trackViewUrl: 'https://apps.apple.com/ng/app/hook/id111' },
    { bundleId: 'com.biodun42.hook', trackViewUrl: 'https://apps.apple.com.evil.test/ng/app/hook/id222' },
    { bundleId: 'com.biodun42.hook', trackViewUrl: 'https://apps.apple.com/ng/app/hook/id333?uo=4' },
  ] }), { status: 200 }));
  assert.equal(await resolveHookAppStoreUrl(), 'https://apps.apple.com/ng/app/hook/id333');
});
test('missing Apple listing never sends an iPhone to Google Play or another app', { skip }, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  assert.equal(await resolveHookAppStoreUrl(), null);
});
