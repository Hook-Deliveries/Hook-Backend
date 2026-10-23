import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AzureNegotiationService } from '../src/modules/negotiation/azure-negotiation.service';

test('Azure invalid output fails closed and authentication errors are not retried', async (t) => {
  const keys = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'AZURE_OPENAI_API_VERSION'];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'unit-test', AZURE_OPENAI_ENDPOINT: 'https://unit.openai.azure.com', AZURE_OPENAI_DEPLOYMENT_NAME: 'unit', AZURE_OPENAI_API_VERSION: '2024-10-21' });
  let calls = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"intent":"execute_database","quantity":null}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const service = new AzureNegotiationService();
    await assert.rejects(service.shoppingIntent('hello'), (error: { code?: string; status?: number; message?: string }) => error.code === 'NEGOTIATION_UNAVAILABLE' && error.message === 'Negotiation is currently unavailable. We’re working to bring it back for you.');
    assert.equal(calls, 1);
    fetch.mock.mockImplementation(async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'Unauthorized', code: '401' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    });
    await assert.rejects(service.shoppingIntent('hello'), (error: { code?: string }) => error.code === 'NEGOTIATION_UNAVAILABLE');
    assert.equal(calls, 2);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
