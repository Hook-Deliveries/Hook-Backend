import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Request, Response } from 'express';
import { AdminCategoriesController } from '../src/controllers/admin/categories.controller';
import { HttpError } from '../src/utils/http';
import { Category } from '../src/models/categories/category.model';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

const controller = new AdminCategoriesController();

before(async () => { await startDatabase(); });
after(async () => { await stopDatabase(); });
beforeEach(async () => { await resetDatabase(); });

function call(body: Record<string, unknown>) {
  const req = { body, params: {}, query: {}, user: { sub: 'admin-1' }, headers: {}, ip: '127.0.0.1', header: () => undefined } as unknown as Request;
  let status = 200; let payload: unknown;
  const res = { req, status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; return this; }, setHeader() { return this; } } as unknown as Response;
  return controller.reorder(req, res).then(() => ({ status, payload: payload as any }));
}

async function seed(names: string[], parentId?: string) {
  const rows = await Category.create(
    names.map((name, index) => ({ name, slug: `${parentId || 'root'}-${name.toLowerCase()}`, sortOrder: index, isActive: true, ...(parentId ? { parentId, level: 1 } : { level: 0 }) })) as never,
  );
  return rows.map((row) => String(row._id));
}

test('reordering sets sortOrder to match the given order, ten apart', async () => {
  const [a, b, c] = await seed(['A', 'B', 'C']);
  await call({ ids: [c, a, b] });
  const rows = await Category.find({ _id: { $in: [a, b, c] } }).select('_id sortOrder').lean();
  const orderOf = (id: string) => rows.find((row) => String(row._id) === id)!.sortOrder;
  assert.equal(orderOf(c), 10);
  assert.equal(orderOf(a), 20);
  assert.equal(orderOf(b), 30);
});

test('categories from two different parents cannot be reordered together', async () => {
  const [a] = await seed(['A']);
  const [x] = await seed(['X'], a);
  const [y] = await seed(['Y']);
  await assert.rejects(() => call({ ids: [x, y] }), (error: HttpError) => error.statusCode === 400);
});

test('an id that does not exist refuses the whole request', async () => {
  const [a, b] = await seed(['A', 'B']);
  await assert.rejects(() => call({ ids: [a, b, '000000000000000000000000'] }), (error: HttpError) => error.statusCode === 400);
});
