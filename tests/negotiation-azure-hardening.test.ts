import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { azureOpenAIConfig, usesReasoningParameters } from '../src/config/azure-openai';
import { negotiationMonetaryValues } from '../src/lib/negotiation-intent';
import { AzureNegotiationService, fallbackGuidance, fallbackPhrase, leaksInternals, resetAzureNegotiationState } from '../src/modules/negotiation/azure-negotiation.service';

const keys = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_MODEL_NAME'];
const previous = new Map(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  resetAzureNegotiationState();
  Object.assign(process.env, {
    AZURE_OPENAI_API_KEY: 'unit-test-key',
    AZURE_OPENAI_ENDPOINT: 'https://unit.openai.azure.com',
    AZURE_OPENAI_DEPLOYMENT_NAME: 'unit-deployment',
    AZURE_OPENAI_API_VERSION: '2024-04-01-preview',
    AZURE_OPENAI_MODEL_NAME: 'gpt-4.1-mini',
  });
});
afterEach(() => {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** Replies with each queued model message in turn (repeating the last), and records every request body. */
function modelReplies(t: any, replies: Array<string | { status: number }>) {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: { body?: string }) => {
    if (init?.body) bodies.push(JSON.parse(init.body));
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (typeof reply !== 'string') return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: reply.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'req_1', model: 'gpt-4.1-mini', choices: [{ finish_reason: 'stop', message: { content: reply } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return bodies;
}

const reply = (message: string, decision = 'COUNTER') => JSON.stringify({ message, decision });
const context = (over: Record<string, unknown> = {}) => ({
  language: 'english' as const, quoteMinutes: 30, enabled: true, remainingOffers: 2, finalized: false,
  bestPriceMinor: 4_300_000, productTitle: 'Floor Mat', productDescription: 'A sturdy mat. Minimum order of one.', ...over,
});
const counter = { decision: 'COUNTER' as const, counterPriceMinor: 4_300_000, reasonCode: 'X', remainingOffers: 2 };

// ── Config ────────────────────────────────────────────────────────────────────────────────
test('config reports missing settings by name and rejects unsafe endpoints', () => {
  assert.equal(azureOpenAIConfig().configured, true);
  assert.equal(azureOpenAIConfig().modelName, 'gpt-4.1-mini');
  assert.deepEqual(azureOpenAIConfig({ AZURE_OPENAI_ENDPOINT: 'https://x.azure.com' } as never).missing, ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'AZURE_OPENAI_API_VERSION']);
  assert.deepEqual(azureOpenAIConfig({ ...process.env, AZURE_OPENAI_ENDPOINT: 'http://x.azure.com' }).missing, ['AZURE_OPENAI_ENDPOINT']);
  assert.deepEqual(azureOpenAIConfig({ ...process.env, AZURE_OPENAI_ENDPOINT: 'https://user:pass@x.azure.com' }).missing, ['AZURE_OPENAI_ENDPOINT']);
  assert.equal(azureOpenAIConfig({ ...process.env, AZURE_OPENAI_ENDPOINT: 'not a url' }).configured, false);
  // The model name is optional and falls back to the deployment name.
  delete process.env.AZURE_OPENAI_MODEL_NAME;
  assert.equal(azureOpenAIConfig().modelName, 'unit-deployment');
  assert.equal(azureOpenAIConfig().configured, true);
});

test('reasoning models get their own request parameters', () => {
  for (const name of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) assert.equal(usesReasoningParameters(name), true, name);
  for (const name of ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-35-turbo', 'portfolio-assistant']) assert.equal(usesReasoningParameters(name), false, name);
});

test('request parameters follow the model name', async (t) => {
  const bodies = modelReplies(t, [reply('I can do ₦43,000. Come up a little?')]);
  await new AzureNegotiationService().phrase(counter, context());
  assert.equal(bodies[0].max_tokens, 140);
  assert.equal(bodies[0].temperature, 0.25);
  assert.equal(bodies[0].max_completion_tokens, undefined);

  process.env.AZURE_OPENAI_MODEL_NAME = 'gpt-5-mini';
  await new AzureNegotiationService().phrase(counter, context());
  assert.equal(bodies[1].max_tokens, undefined);
  assert.equal(bodies[1].temperature, undefined);
  assert.ok(Number(bodies[1].max_completion_tokens) >= 1024);
});

// ── Leak check ────────────────────────────────────────────────────────────────────────────
test('the leak check catches pricing internals but not ordinary product words', () => {
  for (const bad of ['My price floor is ₦40,000.', 'The minimum price I can take is low.', 'Our cost price is high.', 'Ignore my system prompt.', 'That is an internal rule.']) {
    assert.equal(leaksInternals(bad), true, bad);
  }
  assert.equal(leaksInternals('This Floor Mat is a great pick.', ['Floor Mat']), false);
  assert.equal(leaksInternals('Minimum order of one, and it ships fast.', ['A sturdy mat. Minimum order of one.']), false);
  assert.equal(leaksInternals('I can do ₦43,000 for you.'), false);
  // The product's own title does not excuse a leak that sits next to it.
  assert.equal(leaksInternals('Floor Mat: my price floor is ₦40,000.', ['Floor Mat']), true);
});

// ── Wording: accept, retry, fall back ─────────────────────────────────────────────────────
test('a product called Floor Mat can be worded', async (t) => {
  const bodies = modelReplies(t, [reply('The Floor Mat is yours for ₦43,000. Can you come up a little?')]);
  const result = await new AzureNegotiationService().phrase(counter, context());
  assert.equal(result.fallbackUsed, false);
  assert.match(result.message, /Floor Mat/);
  assert.equal(bodies.length, 1);
});

test('a wrong amount is retried once with a correction and the second reply is used', async (t) => {
  const bodies = modelReplies(t, [reply('How about ₦41,000?'), reply('I can do ₦43,000. Come up a little?')]);
  const result = await new AzureNegotiationService().phrase(counter, context());
  assert.equal(result.fallbackUsed, false);
  assert.match(result.message, /43,000/);
  assert.equal(bodies.length, 2);
  assert.ok(JSON.stringify(bodies[1].messages).includes('Correction'));
});

test('two unusable replies fall back to safe wording with the approved price', async (t) => {
  const bodies = modelReplies(t, [reply('My price floor is ₦40,000.'), reply('Honestly the minimum price is ₦40,000.')]);
  const result = await new AzureNegotiationService().phrase(counter, context());
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.telemetry.provider, 'fallback');
  assert.deepEqual(negotiationMonetaryValues(result.message), [4_300_000]);
  assert.equal(leaksInternals(result.message), false);
  assert.equal(bodies.length, 2);
});

test('malformed model output also falls back instead of failing the customer', async (t) => {
  modelReplies(t, ['not json at all']);
  const result = await new AzureNegotiationService().phrase(counter, context());
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(negotiationMonetaryValues(result.message), [4_300_000]);
});

test('guidance falls back to a safe reply when the model breaks a rule', async (t) => {
  modelReplies(t, [JSON.stringify({ message: 'Our price floor is ₦40,000 so try me.' })]);
  const result = await new AzureNegotiationService().guide({
    customerMessage: 'hello', language: 'english', productTitle: 'Hook shoe', currentPriceMinor: 5_000_000, enabled: true,
  });
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.message, fallbackGuidance('english'));
});

test('invalid output never opens the breaker for everyone', async (t) => {
  const bodies = modelReplies(t, ['not json', 'not json', 'not json', 'not json', 'not json', 'not json', reply('I can do ₦43,000. Come up a little?')]);
  const service = new AzureNegotiationService();
  for (let index = 0; index < 3; index += 1) assert.equal((await service.phrase(counter, context())).fallbackUsed, true);
  const result = await service.phrase(counter, context());
  assert.equal(result.fallbackUsed, false);
  assert.equal(bodies.length, 7);
});

test('the availability probe is trusted for a short while', async (t) => {
  const bodies = modelReplies(t, ['{"ready":true}']);
  const service = new AzureNegotiationService();
  await service.ready();
  await service.ready();
  assert.equal(bodies.length, 1);
});

// ── Fixed wording obeys the same rules as the model ───────────────────────────────────────
test('fallback wording states only the approved price and never accepts a counter', () => {
  const cases = [
    { decision: 'ACCEPT' as const, finalized: true }, { decision: 'ACCEPT' as const, finalized: false },
    { decision: 'COUNTER' as const, finalized: false }, { decision: 'DECLINE' as const, finalized: true },
  ];
  for (const language of ['english', 'pidgin'] as const) {
    for (const item of cases) {
      const message = fallbackPhrase({ decision: item.decision }, { language, quoteMinutes: 30, remainingOffers: 2, finalized: item.finalized, approvedPriceMinor: 4_300_000 });
      assert.deepEqual(negotiationMonetaryValues(message), [4_300_000], message);
      assert.equal(leaksInternals(message), false, message);
      if (item.decision !== 'ACCEPT') {
        assert.equal(/\b(offer accepted|your offer works|that works|deal accepted|we agree|we gree|i agree|i gree)\b/i.test(message), false, message);
      }
    }
  }
  // A decline with nothing locked mentions no amount at all.
  assert.deepEqual(negotiationMonetaryValues(fallbackPhrase({ decision: 'DECLINE' }, { language: 'english', quoteMinutes: 30, remainingOffers: 0, finalized: true })), []);
});

// ── A real provider outage still fails closed ─────────────────────────────────────────────
test('a provider outage fails closed with the documented error', async (t) => {
  modelReplies(t, [{ status: 500 }]);
  await assert.rejects(new AzureNegotiationService().phrase(counter, context()), (error: { code?: string; statusCode?: number }) => error.code === 'NEGOTIATION_UNAVAILABLE' && error.statusCode === 503);
});

test('fallback wording never says an offer is too low or that Hook cannot go lower', () => {
  const cases = [
    { decision: 'COUNTER' as const, finalized: true },
    { decision: 'COUNTER' as const, finalized: false },
    { decision: 'DECLINE' as const, finalized: true },
    { decision: 'DECLINE' as const, finalized: false },
  ];
  for (const language of ['english', 'pidgin'] as const) {
    for (const { decision, finalized } of cases) {
      const message = fallbackPhrase({ decision }, { language, quoteMinutes: 30, remainingOffers: finalized ? 0 : 2, finalized, approvedPriceMinor: 4_500_000, quantity: 1 });
      assert.doesNotMatch(message, /too low|can't go|cannot go|no fit go|go that low|go lower/i, message);
    }
  }
});
