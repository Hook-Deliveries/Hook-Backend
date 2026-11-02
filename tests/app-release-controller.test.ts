import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AppReleasesController } from '../src/controllers/admin/app-releases.controller';
import { AppRelease } from '../src/models/platform/app-release.model';
import { PlatformAuditLog } from '../src/models/platform/audit-log.model';
import { PublicIdCounter } from '../src/models/platform/counter.model';
import { realtime } from '../src/modules/platform/realtime.service';

test('announcements create both platforms with ordered writes in the same transaction', async (t) => {
  let committed = false;
  let ended = false;
  const session = {
    withTransaction: async (callback: () => Promise<void>) => { await callback(); committed = true; },
    endSession: async () => { ended = true; },
  };
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(AppRelease, 'find', () => ({ session: (value: unknown) => {
    assert.equal(value, session);
    return { lean: async () => [] };
  } }));
  t.mock.method(AppRelease, 'updateMany', async (_filter: unknown, _update: unknown, options: { session: unknown }) => { assert.equal(options.session, session); });
  const create = t.mock.method(AppRelease, 'create', async (documents: { platform: string; version: string; status: string }[], options: { session: unknown; ordered?: boolean }) => {
    assert.equal(options.session, session);
    assert.equal(options.ordered, true, 'Mongoose requires ordered: true for multiple documents in a session');
    assert.deepEqual(documents.map((document) => document.platform), ['android', 'ios']);
    assert.ok(documents.every((document) => document.version === '1.2.0' && document.status === 'published'));
    return documents;
  });
  t.mock.method(PublicIdCounter, 'findOneAndUpdate', () => ({ lean: async () => ({ sequence: 1 }) }));
  t.mock.method(PlatformAuditLog, 'create', async () => { assert.equal(committed, true); });
  const broadcast = t.mock.method(realtime, 'emit', (event: { type: string }, targets: { public?: boolean }) => {
    assert.equal(committed, true);
    assert.equal(event.type, 'app-release.updated');
    assert.equal(targets.public, true);
  });
  const req = { body: { version: '1.2.0' }, user: { sub: 'admin' }, header: () => undefined } as unknown as Request;
  let status = 0;
  let response: { success: boolean } | undefined;
  const res = { req, status: (value: number) => { status = value; return res; }, json: (value: { success: boolean }) => { response = value; } } as unknown as Response;
  await new AppReleasesController().create(req, res);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(broadcast.mock.callCount(), 1);
  assert.equal(ended, true);
  assert.equal(status, 201);
  assert.equal(response?.success, true);
});

test('a failed platform write closes the session without reporting announcement success', async (t) => {
  let ended = false;
  const session = { withTransaction: async (callback: () => Promise<void>) => callback(), endSession: async () => { ended = true; } };
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(AppRelease, 'find', () => ({ session: () => ({ lean: async () => [] }) }));
  t.mock.method(AppRelease, 'updateMany', async () => undefined);
  const failure = new Error('Platform write failed');
  t.mock.method(AppRelease, 'create', async () => { throw failure; });
  const audit = t.mock.method(PlatformAuditLog, 'create', async () => undefined);
  const broadcast = t.mock.method(realtime, 'emit', () => undefined);
  const req = { body: { version: '1.2.0' }, user: { sub: 'admin' } } as unknown as Request;
  const res = { status: () => { assert.fail('Must not return success'); } } as unknown as Response;
  await assert.rejects(new AppReleasesController().create(req, res), failure);
  assert.equal(ended, true);
  assert.equal(audit.mock.callCount(), 0);
  assert.equal(broadcast.mock.callCount(), 0);
});
