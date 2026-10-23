import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { requestTiming } from '../src/middleware/request-timing';

function run(path: string) {
  const req = {
    method: 'GET', path, originalUrl: `${path}?token=secret`, requestId: 'req-1',
    route: { path }, user: { publicId: 'usr_1' }, ip: '1.2.3.4',
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, headersSent: false, setHeader() {}, end() {},
  }) as unknown as Response;
  const lines: string[] = [];
  const original = console.info;
  const env = process.env.NODE_ENV;
  console.info = (line: string) => { lines.push(line); };
  process.env.NODE_ENV = 'production';
  try {
    requestTiming(req, res, (() => {}) as NextFunction);
    (res as unknown as EventEmitter).emit('finish');
  } finally {
    console.info = original;
    process.env.NODE_ENV = env;
  }
  return lines.map((line) => JSON.parse(line));
}

test('production logs one JSON line per request with its request ID and no query string', () => {
  const [entry] = run('/api/v1/orders');
  assert.equal(entry.event, 'request');
  assert.equal(entry.requestId, 'req-1');
  assert.equal(entry.path, '/api/v1/orders');
  assert.equal(entry.status, 200);
  assert.equal(entry.userId, 'usr_1');
  assert.equal(typeof entry.durationMs, 'number');
});

test('health checks are not logged', () => {
  assert.equal(run('/health').length, 0);
});
