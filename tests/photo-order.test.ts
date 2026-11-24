import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalSubmissionMedia, orderApprovedAssets } from '../src/modules/catalog/catalog.service';
import { orderedProductMedia } from '../src/modules/catalog/commercial-catalog.service';

test('canonicalSubmissionMedia puts front, side and back first, then extras, whatever order the client sent', () => {
  const result = canonicalSubmissionMedia(['E1', 'B', 'F', 'E2', 'S'], { front: 'F', side: 'S', back: 'B' });
  assert.deepEqual(result.mediaIds, ['F', 'S', 'B', 'E1', 'E2']);
  assert.deepEqual(result.mediaViews, { front: 'F', side: 'S', back: 'B' });
});

test('canonicalSubmissionMedia drops a view that points at a photo that is not in the list, and never repeats a photo', () => {
  const result = canonicalSubmissionMedia(['F', 'S'], { front: 'F', side: 'S', back: 'GONE' });
  assert.deepEqual(result.mediaIds, ['F', 'S']);
  assert.deepEqual(result.mediaViews, { front: 'F', side: 'S' });
  // The same photo assigned to two views counts once, for the first view.
  const duplicate = canonicalSubmissionMedia(['A', 'B'], { front: 'A', side: 'A', back: 'B' });
  assert.deepEqual(duplicate.mediaIds, ['A', 'B']);
  assert.deepEqual(duplicate.mediaViews, { front: 'A', back: 'B' });
});

test('canonicalSubmissionMedia with no views keeps the order it was given', () => {
  assert.deepEqual(canonicalSubmissionMedia(['X', 'Y', 'Z']).mediaIds, ['X', 'Y', 'Z']);
});

test('orderApprovedAssets follows the reviewer gallery, then capture order for anything the gallery does not place', () => {
  const assets = [
    { publicId: 'MED-A', secureUrl: 'https://img/a.jpg' },
    { publicId: 'MED-B', secureUrl: 'https://img/b.jpg' },
    { publicId: 'MED-C', secureUrl: 'https://img/c.jpg' },
    { publicId: 'MED-D', secureUrl: 'https://img/d.jpg' },
  ];
  // The reviewer put C first and B second, and left A and D out of the gallery order.
  const ordered = orderApprovedAssets(assets, ['https://img/c.jpg', 'https://img/b.jpg'], ['MED-D', 'MED-A', 'MED-B', 'MED-C'], (asset) => asset.secureUrl);
  assert.deepEqual(ordered.map((asset) => asset.publicId), ['MED-C', 'MED-B', 'MED-D', 'MED-A']);
});

test('orderedProductMedia shows the gallery in its saved order with a position, borrowing sizes from the uploaded photos', () => {
  const product = { title: 'Runner', images: ['https://img/side.jpg', 'https://img/front.jpg'] };
  const assetMedia = [
    { type: 'image', url: 'https://img/front.jpg', width: 800, height: 1000, alt: 'Runner' },
    { type: 'image', url: 'https://img/side.jpg', width: 1200, height: 900, alt: 'Runner' },
  ];
  const media = orderedProductMedia(product, assetMedia);
  assert.deepEqual(media.map((item) => item.url), ['https://img/side.jpg', 'https://img/front.jpg']);
  assert.deepEqual(media.map((item) => item.position), [0, 1]);
  assert.equal(media[0].width, 1200);
  assert.equal(media[1].height, 1000);
});

test('orderedProductMedia falls back to the uploaded photos when a product has no gallery', () => {
  const assetMedia = [{ type: 'image', url: 'https://img/1.jpg', width: 1, height: 1, alt: 'x' }, { type: 'image', url: 'https://img/2.jpg', width: 1, height: 1, alt: 'x' }];
  const media = orderedProductMedia({ title: 'x' }, assetMedia);
  assert.deepEqual(media.map((item) => item.url), ['https://img/1.jpg', 'https://img/2.jpg']);
  assert.deepEqual(media.map((item) => item.position), [0, 1]);
});
