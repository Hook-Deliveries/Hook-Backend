import assert from 'node:assert/strict';
import { test } from 'node:test';
import client from 'prom-client';
import type { Request, Response } from 'express';
import { recordRequest } from '../src/lib/metrics';

test('requests are recorded by route template, and unknown paths share one label', async () => {
  recordRequest({ method: 'GET', baseUrl: '/api/v1', route: { path: '/orders/:id' } } as unknown as Request, { statusCode: 200 } as Response, 42);
  recordRequest({ method: 'GET', baseUrl: '', route: undefined } as unknown as Request, { statusCode: 404 } as Response, 3);
  const out = await client.register.getSingleMetricAsString('http_request_duration_seconds');
  assert.match(out, /route="\/api\/v1\/orders\/:id",status="200"/);
  assert.match(out, /route="unmatched",status="404"/);
});
