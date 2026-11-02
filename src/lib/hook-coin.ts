export type HookCoinEarnSettings = {
  enabled?: boolean;
  percent?: number;
  maxMinor?: number;
};

/**
 * Canonical Hook credit order reward calculation. Product subtotal is used on
 * purpose: delivery, VAT, coupons and spent Hook credit do not increase or
 * reduce the reward earned for the purchased products.
 */
export function calculateHookCoinEarnMinor(
  subtotalMinor: number,
  settings: HookCoinEarnSettings,
) {
  if (settings.enabled === false || !Number.isFinite(subtotalMinor) || subtotalMinor <= 0)
    return 0;

  const percent = Math.min(Math.max(Number(settings.percent ?? 1), 0), 100);
  if (percent <= 0) return 0;

  const earnedMinor = Math.round((subtotalMinor * percent) / 100);
  const maxMinor = Math.max(0, Number(settings.maxMinor ?? 0));
  return maxMinor > 0 ? Math.min(earnedMinor, maxMinor) : earnedMinor;
}
