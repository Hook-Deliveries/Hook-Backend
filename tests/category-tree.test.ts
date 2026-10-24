import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { Category } from '../src/models/categories/category.model';
import { categoryService } from '../src/modules/catalog/category.service';
import { CATEGORY_TREE } from '../src/database/category-tree';

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); await seedTree(); });

const slugify = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function seedTree() {
  let order = 0;
  for (const node of CATEGORY_TREE) {
    const parentSlug = slugify(node.name);
    const parent = await Category.create({
      publicId: `CAT-${order}`, name: node.name, slug: parentSlug, sortOrder: (order += 1), isActive: true, level: 0, path: parentSlug,
      attributeSchema: node.attributes ? { attributes: node.attributes } : {},
    });
    let child = 0;
    for (const item of node.children || []) {
      const slug = `${parentSlug}-${slugify(item.name)}`;
      await Category.create({
        publicId: `CAT-${order}-${child}`, name: item.name, slug, sortOrder: (child += 1), isActive: true, level: 1, parentId: String(parent._id), path: `${parentSlug}/${slug}`,
        attributeSchema: item.attributes ? { attributes: item.attributes } : {},
      });
    }
  }
}

const bySlug = (slug: string) => Category.findOne({ slug }).lean() as Promise<any>;
const rejectsWith = (fn: () => Promise<unknown>, pattern: RegExp) => assert.rejects(fn, (error: any) => pattern.test(String(error.message)));

test('the seeded tree has eleven top-level categories and Wigs is a leaf', async () => {
  const tree = await categoryService.tree();
  assert.equal(tree.length, 11);
  assert.deepEqual(tree.find((node) => node.name === 'Wigs')?.children, []);
  assert.equal(tree.find((node) => node.name === 'Shoes')?.children.length, 8);
  assert.equal(tree.find((node) => node.name === 'Gadgets')?.children.length, 7);
});

test('a product may be filed under a leaf, including a top-level category with no children', async () => {
  const sneakers = await bySlug('shoes-sneakers-male');
  await assert.doesNotReject(() => categoryService.assertAssignable(String(sneakers._id)));
  const wigs = await bySlug('wigs');
  await assert.doesNotReject(() => categoryService.assertAssignable(String(wigs._id)));
});

test('a parent that has sub-categories cannot hold products', async () => {
  const shoes = await bySlug('shoes');
  await rejectsWith(() => categoryService.assertAssignable(String(shoes._id)), /has sub-categories/);
});

test('an inactive parent makes its sub-categories unassignable and hides them from customers', async () => {
  const shoes = await bySlug('shoes');
  await Category.updateOne({ _id: shoes._id }, { $set: { isActive: false } });
  const sneakers = await bySlug('shoes-sneakers-male');
  await rejectsWith(() => categoryService.assertAssignable(String(sneakers._id)), /parent category is inactive/);
  const tree = await categoryService.tree();
  assert.equal(tree.some((node) => node.name === 'Shoes'), false);
});

test('filtering by a parent covers every sub-category, and by a leaf only itself', async () => {
  const shoes = await bySlug('shoes');
  const ids = await categoryService.descendantIds(String(shoes._id));
  assert.equal(ids.length, 9);
  const sneakers = await bySlug('shoes-sneakers-male');
  assert.deepEqual(await categoryService.descendantIds(String(sneakers._id)), [String(sneakers._id)]);
});

test('a sub-category inherits its parent\'s attributes', async () => {
  const sneakers = await bySlug('shoes-sneakers-female');
  const attributes = await categoryService.attributesFor(sneakers);
  assert.deepEqual(attributes.map((attribute) => attribute.key), ['size', 'colour']);
});

test('gadgets take no size: a powerbank passes without one and is refused with one', async () => {
  const powerbank = await bySlug('gadgets-powerbank');
  await assert.doesNotReject(() => categoryService.validateVariants(powerbank, [{ colour: 'Black', attributes: { capacity: '10,000 mAh' } }]));
  await rejectsWith(() => categoryService.validateVariants(powerbank, [{ colour: 'Black', size: 'L', attributes: { capacity: '10,000 mAh' } }]), /does not use sizes/);
});

test('shoes need a size, and a phone case needs its phone model', async () => {
  const sneakers = await bySlug('shoes-sneakers-male');
  await rejectsWith(() => categoryService.validateVariants(sneakers, [{ colour: 'White' }]), /Shoe size is required/);
  await assert.doesNotReject(() => categoryService.validateVariants(sneakers, [{ colour: 'White', size: '42' }]));
  const cases = await bySlug('gadgets-phone-cases');
  await rejectsWith(() => categoryService.validateVariants(cases, [{ colour: 'Black' }]), /Phone model is required/);
});

test('select attributes only accept their listed options', async () => {
  const powerbank = await bySlug('gadgets-powerbank');
  await rejectsWith(() => categoryService.validateVariants(powerbank, [{ colour: 'Black', attributes: { capacity: '999 mAh' } }]), /Capacity must be one of/);
});

test('children shoes require a gender', async () => {
  const kids = await bySlug('children-children-shoes');
  await rejectsWith(() => categoryService.validateVariants(kids, [{ colour: 'Blue', size: '28' }]), /Gender is required/);
  await assert.doesNotReject(() => categoryService.validateVariants(kids, [{ colour: 'Blue', size: '28', attributes: { gender: 'Male' } }]));
});

test('a category with no template accepts any variant, so older data keeps working', async () => {
  const legacy = await Category.create({ publicId: 'CAT-LEGACY', name: 'Legacy', slug: 'legacy', isActive: true, level: 0 });
  await assert.doesNotReject(() => categoryService.validateVariants(legacy.toObject() as any, [{ size: 'XL' }]));
});

test('a variant may not carry a detail the category does not ask for', async () => {
  const powerbank = await bySlug('gadgets-powerbank');
  await rejectsWith(() => categoryService.validateVariants(powerbank, [{ colour: 'Black', attributes: { capacity: '10,000 mAh', phoneModel: 'iPhone' } }]), /phoneModel is not asked for/);
  // Empty values are ignored, not treated as a stray detail.
  await assert.doesNotReject(() => categoryService.validateVariants(powerbank, [{ colour: 'Black', attributes: { capacity: '10,000 mAh', phoneModel: '' } }]));
});
