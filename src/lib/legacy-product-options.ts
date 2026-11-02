import { createHash } from 'crypto';

export function legacyProductOptions(product: { _id: { toString(): string }; colors?: unknown[]; sizes?: unknown[] }) {
  const clean = (values: unknown[] = []) => [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))];
  const colours = clean(product.colors);
  const sizes = clean(product.sizes);
  const options = colours.length && sizes.length
    ? colours.flatMap((colour) => sizes.map((size) => ({ colour, size })))
    : colours.length ? colours.map((colour) => ({ colour, size: undefined }))
      : sizes.map((size) => ({ colour: undefined, size }));
  return options.map((option) => ({ ...option, publicId: `legacy_opt_${createHash('sha256').update(JSON.stringify([product._id.toString(), option.colour || '', option.size || ''])).digest('hex').slice(0, 32)}` }));
}
