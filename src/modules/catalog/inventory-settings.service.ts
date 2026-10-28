import { CommerceSettings } from '@models/commerce/commerce.model';
import { inventorySettingsCache } from '@lib/ttl-cache';

const CACHE_KEY = 'low-stock-threshold';
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/**
 * Admin-configurable point at which customers start seeing a low-stock
 * warning on a product. Cached because it is read on every catalog response.
 */
export async function getLowStockThreshold(): Promise<number> {
  const cached = inventorySettingsCache.get(CACHE_KEY);
  if (typeof cached === 'number') return cached;

  const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('lowStockThreshold').lean();
  const threshold = typeof settings?.lowStockThreshold === 'number'
    ? settings.lowStockThreshold
    : DEFAULT_LOW_STOCK_THRESHOLD;
  inventorySettingsCache.set(CACHE_KEY, threshold);
  return threshold;
}

export function clearInventorySettingsCache() {
  inventorySettingsCache.clear();
}
