import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyNegotiationMessage, negotiationMoneyFromMessage } from "../src/lib/negotiation-intent";

test("explicit money is not confused with sizes or quantities", () => {
  assert.equal(negotiationMoneyFromMessage("size 45, what about 40k"), 4000000);
  assert.equal(negotiationMoneyFromMessage("abeg take NGN 40,000"), 4000000);
  assert.equal(negotiationMoneyFromMessage("₦1.5m"), 150000000);
  assert.equal(negotiationMoneyFromMessage("give me 2"), undefined);
  assert.equal(negotiationMoneyFromMessage("40k or 50k"), undefined);
});

test("quantity requests never become price offers", () => {
  for (const message of [
    "give me 2",
    "Give me two",
    "add 3 to cart",
    "make it four",
    "give me 2 for 80k",
  ]) {
    assert.ok(
      ["cart", "quantity"].includes(classifyNegotiationMessage(message).intent),
      message,
    );
  }
  assert.equal(classifyNegotiationMessage("give me two").quantity, 2);
});
test("money offers stay price intents", () => {
  for (const message of [
    "₦80,000",
    "NGN 80000",
    "I will pay 80k",
    "offer 1m",
    "80000",
    "I want 80 k",
  ]) {
    assert.equal(classifyNegotiationMessage(message).intent, "offer", message);
  }
});
test("budget alternatives and ordinal references", () => {
  assert.deepEqual(
    classifyNegotiationMessage("show me cheaper ones under 80k"),
    { intent: "alternatives", budgetMinor: 8000000 },
  );
  assert.equal(classifyNegotiationMessage("the second one").selection, 1);
  assert.equal(classifyNegotiationMessage("this one").selection, undefined);
  assert.equal(
    classifyNegotiationMessage("proceed to checkout").intent,
    "checkout",
  );
  assert.equal(
    classifyNegotiationMessage("abeg show me alternatives").intent,
    "alternatives",
  );
});
