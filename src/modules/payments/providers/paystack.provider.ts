import { createHash, createHmac, timingSafeEqual } from "crypto";
import {
  PaymentProvider,
  ProviderInitializeInput,
  ProviderTransaction,
} from "@modules/payments/providers/payment-provider";
import { HttpError } from "@utils/http";

export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack" as const;
  private readonly baseUrl =
    process.env.PAYSTACK_BASE_URL || "https://api.paystack.co";

  private secret() {
    const value = process.env.PAYSTACK_SECRET_KEY;
    if (!value)
      throw new HttpError(
        503,
        "Paystack payments are not configured",
        undefined,
        "PAYMENT_PROVIDER_UNAVAILABLE",
      );
    return value;
  }

  readiness() {
    return {
      configured: Boolean(process.env.PAYSTACK_SECRET_KEY),
      mode: (String(process.env.PAYSTACK_SECRET_KEY || "").startsWith("sk_live_") ? "live" : "test") as "live" | "test",
      reason: process.env.PAYSTACK_SECRET_KEY ? undefined : "Secret key is missing",
    };
  }

  async initialize(input: ProviderInitializeInput) {
    const response = await this.request("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        amount: String(input.amountMinor),
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: JSON.stringify(input.metadata),
      }),
    });
    const data = response.data as Record<string, string>;
    if (
      !data?.authorization_url ||
      !data?.access_code ||
      data.reference !== input.reference
    )
      throw new HttpError(
        502,
        "Payment provider returned an invalid initialization response",
        undefined,
        "PAYMENT_PROVIDER_ERROR",
      );
    return {
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      reference: data.reference,
    };
  }

  async verify(reference: string): Promise<ProviderTransaction> {
    const response = await this.request(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: "GET" },
    );
    const data = response.data as Record<string, any>;
    return {
      reference: String(data.reference || ""),
      status: String(data.status || ""),
      amountMinor: Number(data.amount || 0),
      currency: String(data.currency || "").toUpperCase(),
      providerId: data.id ? String(data.id) : undefined,
      paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
      raw: data,
    };
  }

  async refund(input: { reference: string; amountMinor: number; reason?: string; idempotencyKey?: string }) {
    const response = await this.request('/refund', {
      method: 'POST',
      body: JSON.stringify({
        transaction: input.reference,
        amount: String(input.amountMinor),
        customer_note: input.reason,
        // Paystack has no idempotency header for refunds, so the key travels
        // in the merchant note. lookupRefund() matches on it to find out
        // whether a refund whose response was lost actually went through.
        merchant_note: input.idempotencyKey ? `hook-refund:${input.idempotencyKey}` : 'Hook fulfilment refund',
      }),
    });
    const data = response.data as Record<string, any>;
    const providerReference = String(data?.id || data?.transaction || input.reference);
    if (!providerReference) throw new HttpError(502, 'Payment provider returned an invalid refund response', undefined, 'PAYMENT_PROVIDER_ERROR');
    return { providerReference };
  }

  /** Finds a refund previously created for this key, or undefined if none exists. */
  async lookupRefund(input: { reference: string; amountMinor: number; idempotencyKey: string }) {
    const response = await this.request(`/refund?reference=${encodeURIComponent(input.reference)}`, { method: 'GET' });
    const rows = Array.isArray(response.data) ? (response.data as Array<Record<string, any>>) : [];
    const note = `hook-refund:${input.idempotencyKey}`;
    const match = rows.find(
      (row) =>
        String(row?.merchant_note || '') === note &&
        Number(row?.amount) === input.amountMinor &&
        !['failed', 'reversed'].includes(String(row?.status || '').toLowerCase()),
    );
    return match ? { providerReference: String(match.id || input.reference) } : undefined;
  }

  isSuccessEvent(eventType: string) {
    return eventType === "charge.success";
  }

  parseWebhook(rawBody: Buffer, signature: string) {
    const expected = createHmac("sha512", this.secret())
      .update(rawBody)
      .digest("hex");
    const supplied = String(signature || "").toLowerCase();
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    )
      throw new HttpError(
        401,
        "Invalid webhook signature",
        undefined,
        "WEBHOOK_SIGNATURE_INVALID",
      );
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid webhook payload");
    }
    const data = payload.data || {};
    const reference = data.reference ? String(data.reference) : undefined;
    const providerEventId = String(
      payload.id ||
        `${payload.event || "unknown"}:${reference || createHash("sha256").update(rawBody).digest("hex")}`,
    );
    return {
      eventType: String(payload.event || ""),
      providerEventId,
      reference,
      payload,
    };
  }

  private async request(path: string, init: RequestInit) {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.secret()}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(
        503,
        "Payment provider is temporarily unavailable",
        undefined,
        "PAYMENT_PROVIDER_UNAVAILABLE",
      );
    }
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      any
    >;
    if (!response.ok || body.status !== true)
      throw new HttpError(
        502,
        "Payment provider could not process the request",
        { httpStatus: response.status },
        "PAYMENT_PROVIDER_ERROR",
      );
    return body;
  }
}
