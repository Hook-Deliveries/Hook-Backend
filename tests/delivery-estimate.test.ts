import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDeliveryEstimate } from '../src/lib/delivery-estimate';

const fez = {
  deliveryEstimates: [
    { id: 'a', message: '24 to 48 hours', stateIds: ['STA-2026-000001'] },
    { id: 'b', message: '3 to 5 days', stateIds: ['STA-2026-000002', 'STA-2026-000003'] },
  ],
  defaultEstimate: '2 to 5 days',
};

test('a customer sees the message of the group their State is in', () => {
  assert.equal(resolveDeliveryEstimate(fez, { publicId: 'STA-2026-000001' }), '24 to 48 hours');
  assert.equal(resolveDeliveryEstimate(fez, { publicId: 'STA-2026-000003' }), '3 to 5 days');
});

test('a State no group covers gets the default message', () => {
  assert.equal(resolveDeliveryEstimate(fez, { publicId: 'STA-2026-000009' }), '2 to 5 days');
});

test('with no default and no matching group there is no message', () => {
  assert.equal(resolveDeliveryEstimate({ deliveryEstimates: fez.deliveryEstimates }, { publicId: 'STA-2026-000009' }), undefined);
  assert.equal(resolveDeliveryEstimate({}, { publicId: 'STA-2026-000001' }), undefined);
});

test('an unknown delivery State falls back to the default, and matching ignores case and whitespace', () => {
  assert.equal(resolveDeliveryEstimate(fez, null), '2 to 5 days');
  assert.equal(resolveDeliveryEstimate(fez, { publicId: ' sta-2026-000001 ' }), '24 to 48 hours');
});
