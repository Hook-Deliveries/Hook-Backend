import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createHash } from "node:crypto";
import { NegotiationShoppingService } from "../src/modules/negotiation/negotiation-shopping.service";
import { NegotiationService } from "../src/modules/negotiation/negotiation.service";
import { CartService } from "../src/modules/orders/cart.service";
import { Negotiation } from "../src/models/negotiations/negotiation.model";
import { ProductVariant } from "../src/models/catalog/catalog.model";
import { AzureNegotiationService } from "../src/modules/negotiation/azure-negotiation.service";
import { CommerceSettings } from '../src/models/commerce/commerce.model';

afterEach(() => {
  mock.restoreAll();
});
function fixture(state = "pending") {
  const session = {
    _id: "session",
    publicId: "neg_1",
    customerId: "customer",
    status: "agreed",
    quantity: 2,
    variantId: "variant",
    productId: "product",
    shoppingActions: [
      {
        id: "action",
        state,
        quantity: 2,
        quoteId: "quote",
        receipt: { accepted: true },
      },
    ],
  };
  mock.method(Negotiation, "findOne", () => ({ lean: async () => session }));
  mock.method(ProductVariant, "findOne", () => ({
    lean: async () => ({ publicId: "var_1" }),
  }));
  return session;
}
test("completed confirmation returns its receipt without another cart write", async () => {
  fixture("completed");
  const write = mock.method(CartService.prototype, "addItem", async () => {
    throw new Error("must not write");
  });
  assert.deepEqual(
    await new NegotiationShoppingService().confirm(
      { customerId: "customer" },
      "neg_1",
      "action",
      2,
      "var_1",
    ),
    { accepted: true },
  );
  assert.equal(write.mock.callCount(), 0);
});
test("different quantity and foreign action are rejected before cart mutation", async () => {
  fixture();
  await assert.rejects(
    new NegotiationShoppingService().confirm(
      { customerId: "customer" },
      "neg_1",
      "action",
      3,
      "var_1",
    ),
    /quantity/,
  );
  await assert.rejects(
    new NegotiationShoppingService().confirm(
      { customerId: "customer" },
      "neg_1",
      "foreign",
      2,
      "var_1",
    ),
    /Action not found/,
  );
});
test("ownership lookup is customer-scoped and missing ownership fails", async () => {
  const lookup = mock.method(Negotiation, "findOne", () => ({
    lean: async () => null,
  }));
  await assert.rejects(
    new NegotiationShoppingService().message(
      { customerId: "foreign" },
      "neg_1",
      "give me two",
      "request-key",
    ),
    /not found/,
  );
  assert.equal(
    (lookup.mock.calls[0].arguments[0] as { customerId: string }).customerId,
    "foreign",
  );
});
test("concurrent execution lock rejects a second confirmation", async () => {
  fixture();
  mock.method(Negotiation, "updateOne", async () => ({ modifiedCount: 0 }));
  const write = mock.method(CartService.prototype, "addItem", async () => ({}));
  await assert.rejects(
    new NegotiationShoppingService().confirm(
      { customerId: "customer" },
      "neg_1",
      "action",
      2,
      "var_1",
    ),
    /already processing/,
  );
  assert.equal(write.mock.callCount(), 0);
});
test("failed cart validation releases the action for retry", async () => {
  fixture();
  const updates = mock.method(Negotiation, "updateOne", async () => ({
    modifiedCount: 1,
  }));
  mock.method(CartService.prototype, "addItem", async () => {
    throw new Error("quote expired");
  });
  await assert.rejects(
    new NegotiationShoppingService().confirm(
      { customerId: "customer" },
      "neg_1",
      "action",
      2,
      "var_1",
    ),
    /quote expired/,
  );
  assert.equal(updates.mock.callCount(), 2);
});
test("persisted shopping message replay returns original response", async () => {
  const session = fixture();
  const response = { entry: { kind: "action" }, message: "confirm first" };
  Object.assign(session, {
    idempotencyResults: [
      {
        key: "request-key",
        requestHash: createHash("sha256").update("give me two").digest("hex"),
        response,
      },
    ],
  });
  assert.deepEqual(
    await new NegotiationShoppingService().message(
      { customerId: "customer" },
      "neg_1",
      "give me two",
      "request-key",
    ),
    response,
  );
  await assert.rejects(
    new NegotiationShoppingService().message(
      { customerId: "customer" },
      "neg_1",
      "give me three",
      "request-key",
    ),
    /already used/,
  );
});
test("disabled AI never invokes the legacy negotiation service", async () => {
  fixture();
  mock.method(CommerceSettings, 'findOne', () => ({ select: () => ({ lean: async () => ({ negotiationAzureWordingEnabled: false }) }) }));
  const legacy = mock.method(
    NegotiationService.prototype,
    "offer",
    async () => ({ message: "legacy" }),
  );
  await assert.rejects(new NegotiationShoppingService().message(
    { customerId: "customer" },
    "neg_1",
    "show me cheaper ones",
    "request-key",
  ), { code: 'NEGOTIATION_UNAVAILABLE', statusCode: 503 });
  assert.equal(legacy.mock.callCount(), 0);
});
test("disabled AI guidance fails closed without scripted wording", async () => {
  await assert.rejects(new AzureNegotiationService().guide({
    customerMessage: "hello",
    language: "pidgin",
    productTitle: "Hook shoe",
    currentPriceMinor: 8000000,
    enabled: false,
  }), { code: 'NEGOTIATION_UNAVAILABLE', statusCode: 503 });
});
