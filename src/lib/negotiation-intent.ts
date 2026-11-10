export type ShoppingIntent =
  | "offer"
  | "alternatives"
  | "quantity"
  | "cart"
  | "checkout"
  | "selection"
  | "conversation";

/** Prefer explicit currency/suffix amounts over numbers in sizes or counts.
 * Multiple explicit amounts are ambiguous and must be clarified, not guessed. */
export function negotiationMoneyFromMessage(message: string): number | undefined {
  const amounts = [...message.matchAll(/(?:₦|\bngn\s*)\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?|\b(\d[\d,]*(?:\.\d+)?)\s*([km])\b|\b(\d[\d,]*(?:\.\d+)?)\s*naira\b/gi)];
  if (amounts.length > 1) return undefined;
  const match = amounts[0];
  const fallback = message.trim().match(/^([\d][\d,]*(?:\.\d+)?)$/) || message.match(/\b(?:offer|pay|accept|take|deal|what about)\s+(\d[\d,]*(?:\.\d+)?)\b/i);
  const raw = match ? match[1] || match[3] || match[5] : fallback?.[1];
  const suffix = (match?.[2] || match?.[4] || '').toLowerCase();
  const value = raw ? Math.round(Number(raw.replaceAll(',', '')) * (suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1) * 100) : 0;
  return value > 0 && Number.isSafeInteger(value) ? value : undefined;
}

const NUMBER_WORDS = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|k)\b/i;

/** Every plain number in a message as naira, so a model-extracted amount can be checked against what was written. */
function writtenAmountsNaira(message: string) {
  return [...message.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([km])?\b/gi)].map((match) => {
    const base = Number(match[1].replaceAll(',', ''));
    const suffix = (match[2] || '').toLowerCase();
    return suffix === 'k' ? base * 1000 : suffix === 'm' ? base * 1_000_000 : base;
  }).filter((value) => Number.isFinite(value));
}

/**
 * The model understands how people really haggle ("is it possible to pay 50k", "abeg do forty thousand") and
 * extracts the amount; this decides whether that amount can be trusted. It must be traceable to what the customer
 * wrote (a number in the text, or spelled-out number words), so a model can never invent a price. Returns the
 * offer per unit in kobo, or undefined when there is no trustworthy amount.
 */
// Wording that makes an amount the price of ONE item. Without it, an amount for an order of several items is the total.
const PER_ITEM = /\b(?:each|per\s+(?:item|piece|one|unit|bag|pair)|a\s+piece|apiece|one\s+(?:piece|unit)|for\s+one)\b/i;

export function groundedOfferMinor(
  message: string,
  modelOfferNaira: number | null | undefined,
  _modelSaysTotal: boolean | undefined,
  quantity: number,
): number | undefined {
  // Buying 2 and saying "50k" means 50k for both. Only "each", "per item" and the like make it a per-item price.
  const isTotal = quantity > 1 && !PER_ITEM.test(message);
  const perUnit = (minor: number) => {
    const unit = isTotal ? Math.round(minor / quantity) : minor;
    return unit > 0 && Number.isSafeInteger(unit) ? unit : undefined;
  };
  if (typeof modelOfferNaira === 'number' && Number.isFinite(modelOfferNaira) && modelOfferNaira > 0) {
    const written = writtenAmountsNaira(message);
    const spelledOut = written.length === 0 && NUMBER_WORDS.test(message);
    const traceable = written.some((value) => Math.abs(value - modelOfferNaira) < 0.5) || spelledOut;
    if (traceable) return perUnit(Math.round(modelOfferNaira * 100));
  }
  const explicit = negotiationMoneyFromMessage(message);
  return explicit ? perUnit(explicit) : undefined;
}

export function negotiationMonetaryValues(message: string) {
  return [...message.matchAll(/(?:₦|\bngn\s*)\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?|\b(\d[\d,]*(?:\.\d+)?)\s*([km])\b|\b(\d[\d,]*(?:\.\d+)?)\s*naira\b/gi)].map((match) => {
    const suffix = (match[2] || match[4] || '').toLowerCase();
    return Math.round(Number((match[1] || match[3] || match[5]).replaceAll(',', '')) * (suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1) * 100);
  });
}

export function classifyNegotiationMessage(message: string): {
  intent: ShoppingIntent;
  quantity?: number;
  budgetMinor?: number;
  selection?: number;
} {
  const text = message.trim().toLowerCase();
  if (/\b(checkout|check out|pay now)\b/.test(text))
    return { intent: "checkout" };
  if (/\b(second|third|fourth|first)\s+(one|product|item)\b/.test(text)) {
    return {
      intent: "selection",
      selection: ["first", "second", "third", "fourth"].findIndex((word) =>
        text.includes(word),
      ),
    };
  }
  const quantityMatch = text.match(
    /\b(?:give me|add|buy|i want|i need|make it)\s+(\d+|one|two|three|four|five)\b(?!\s*[km]\b)/,
  );
  const hasMoney = /₦|\b(ngn|naira|pay|offer)\b|\d\s*[km]\b/.test(text);
  if (quantityMatch) {
    const words = ["one", "two", "three", "four", "five"];
    const quantity =
      Number(quantityMatch[1]) || words.indexOf(quantityMatch[1]) + 1;
    return {
      intent: hasMoney
        ? "quantity"
        : /give me|add|buy/.test(text)
          ? "cart"
          : "quantity",
      quantity,
    };
  }
  if (
    /\b(alternative|alternatives|cheaper|affordable|show me|recommend|another product|other products)\b/.test(
      text,
    )
  ) {
    // Prefer explicit money over product counts ("show me 2 under 80k").
    const amount =
      text.match(
        /(?:₦|ngn\s*|budget\s*(?:of\s*)?|under\s*|within\s*)(\d[\d,]*(?:\.\d+)?)\s*([km])?/,
      ) || text.match(/(\d[\d,]*(?:\.\d+)?)\s*([km])\b/);
    const budgetMinor = amount
      ? Math.round(
          Number(amount[1].replaceAll(",", "")) *
            (amount[2] === "k" ? 1000 : amount[2] === "m" ? 1000000 : 1) *
            100,
        )
      : undefined;
    return { intent: "alternatives", budgetMinor };
  }
  if (/\b(add.*cart|give me this|buy this|take this)\b/.test(text))
    return { intent: "cart" };
  if (/\b(this one|that one)\b/.test(text)) return { intent: "selection" };
  if (
    /₦|\b(ngn|naira|offer|pay|price)\b|\d\s*[km]\b/.test(text) ||
    /^\d[\d,.]*$/.test(text)
  )
    return { intent: "offer" };
  return { intent: "conversation" };
}
