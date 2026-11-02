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
