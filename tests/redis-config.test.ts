import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRedisConfig } from '../src/config/redis';

function check(url: string) {
  const prev = { url: process.env.REDIS_URL, env: process.env.NODE_ENV };
  process.env.REDIS_URL = url;
  process.env.NODE_ENV = 'production';
  try {
    assertRedisConfig({ required: true });
  } finally {
    process.env.REDIS_URL = prev.url;
    process.env.NODE_ENV = prev.env;
  }
}

test('production allows plaintext redis:// only to loopback, Docker service names and private networks', () => {
  for (const url of [
    'redis://localhost:6379',
    'redis://:pw@redis:6379',
    'redis://10.0.0.5:6379',
    'redis://172.18.0.2:6379',
    'redis://192.168.1.10:6379',
  ]) {
    assert.doesNotThrow(() => check(url), url);
  }
  for (const url of ['redis://cache.example.com:6379', 'redis://8.8.8.8:6379', 'redis://172.32.0.1:6379']) {
    assert.throws(() => check(url), /rediss:\/\//, url);
  }
  assert.doesNotThrow(() => check('rediss://default:pw@cache.example.com:6380'));
});
