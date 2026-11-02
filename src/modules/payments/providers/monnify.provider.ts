import { createHash, timingSafeEqual } from "crypto";
import {
  PaymentProvider,
  ProviderInitializeInput,
  ProviderTransaction,
} from "@modules/payments/providers/payment-provider";
import { HttpError } from "@utils/http";

/** Monnify's transaction statuses that mean the money actually landed. */
const PAID_STATUSES = new Set(["PAID", "OVERPAID"]);

/** Monnify sends paidOn as "DD/MM/YYYY hh:mm:ss AM/PM", which `new Date()` cannot parse directly. */
function parseMonnifyDate(value: unknown): Date | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(String(value || ""));
  if (!match) return undefined;
  const [, day, month, year, rawHour, minute, second, meridiem] = match;
  let hour = Number(rawHour) % 12;
  if (meridiem.toUpperCase() === "PM") hour += 12;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day), hour, Number(minute), Number(second));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class MonnifyProvider implements PaymentProvider {
  readonly name = "monnify" as const;
  private readonly baseUrl =
    process.env.MONNIFY_BASE_URL || "https://sandbox.monnify.com";
  private token: { value: string; expiresAt: number } | undefined;

  private apiKey() {
    const value = process.env.MONNIFY_API_KEY;
    if (!value) throw new HttpError(503, "Monnify payments are not configured", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    return value;
  }

  private secretKey() {
    const value = process.env.MONNIFY_SECRET_KEY;
    if (!value) throw new HttpError(503, "Monnify payments are not configured", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    return value;
  }

  private contractCode() {
    const value = process.env.MONNIFY_CONTRACT_CODE;
    if (!value) throw new HttpError(503, "Monnify payments are not configured", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    return value;
  }

  readiness() {
    const configured = Boolean(process.env.MONNIFY_API_KEY && process.env.MONNIFY_SECRET_KEY && process.env.MONNIFY_CONTRACT_CODE);
    return {
      configured,
      mode: (this.baseUrl.includes("sandbox") ? "test" : "live") as "live" | "test",
      reason: configured ? undefined : "API key, secret key or contract code is missing",
    };
  }

  /** Tokens last an hour; re-login a few minutes early rather than per request. */
  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const credentials = Buffer.from(`${this.apiKey()}:${this.secretKey()}`).toString("base64");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(503, "Payment provider is temporarily unavailable", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, any>;
    const accessToken = body?.responseBody?.accessToken;
    const expiresIn = Number(body?.responseBody?.expiresIn || 3600);
    if (!response.ok || body.requestSuccessful !== true || !accessToken)
      throw new HttpError(502, "Payment provider could not process the request", { httpStatus: response.status }, "PAYMENT_PROVIDER_ERROR");
    this.token = { value: accessToken, expiresAt: Date.now() + Math.max(0, expiresIn - 300) * 1000 };
    return accessToken;
  }

  async initialize(input: ProviderInitializeInput) {
    const response = await this.request("/api/v1/merchant/transactions/init-transaction", {
      method: "POST",
      body: JSON.stringify({
        amount: input.amountMinor / 100,
        customerName: input.email,
        customerEmail: input.email,
        paymentReference: input.reference,
        paymentDescription: "Hook order payment",
        currencyCode: input.currency,
        contractCode: this.contractCode(),
        redirectUrl: input.callbackUrl,
        metadata: input.metadata,
      }),
    });
    const data = response.responseBody as Record<string, any>;
    if (!data?.checkoutUrl || !data?.transactionReference || data.paymentReference !== input.reference)
      throw new HttpError(502, "Payment provider returned an invalid initialization response", undefined, "PAYMENT_PROVIDER_ERROR");
    return {
      authorizationUrl: String(data.checkoutUrl),
      accessCode: String(data.transactionReference),
      reference: String(data.paymentReference),
    };
  }

  async verify(reference: string): Promise<ProviderTransaction> {
    // /api/v2/transactions/{transactionReference} takes Monnify's own transaction
    // reference (e.g. "MNFY|..."), not our merchant paymentReference — using it here
    // silently 404s and a payment never leaves PROCESSING. The query endpoint accepts
    // our own reference directly, which is all this class ever has on hand.
    const response = await this.request(`/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`, { method: "GET" });
    const data = response.responseBody as Record<string, any>;
    const status = String(data?.paymentStatus || "");
    return {
      reference: String(data?.paymentReference || ""),
      status: PAID_STATUSES.has(status) ? "success" : status.toLowerCase(),
      amountMinor: Math.round(Number(data?.amountPaid || 0) * 100),
      currency: String(data?.currency || "").toUpperCase(),
      providerId: data?.transactionReference ? String(data.transactionReference) : undefined,
      paidAt: parseMonnifyDate(data?.paidOn),
      raw: data,
    };
  }

  /**
   * Monnify disbursements require OTP-via-email by default on every transfer,
   * which cannot be completed headlessly. This only executes once Monnify
   * support has disabled OTP for this merchant's API transfers and the
   * server's static IP is whitelisted — flip MONNIFY_DISBURSEMENT_ENABLED
   * once that's confirmed. Until then, fail loudly instead of hanging on an
   * OTP nobody can complete.
   */
  private assertDisbursementEnabled() {
    if (process.env.MONNIFY_DISBURSEMENT_ENABLED !== "true")
      throw new HttpError(503, "Refunds via Monnify are not yet enabled", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
  }

  async refund(input: { reference: string; amountMinor: number; reason?: string; idempotencyKey?: string }) {
    this.assertDisbursementEnabled();
    const providerReference = input.idempotencyKey ? `hook-refund-${input.idempotencyKey}` : `hook-refund-${input.reference}-${Date.now()}`;
    const response = await this.request("/api/v1/refunds/initiate-refund", {
      method: "POST",
      body: JSON.stringify({
        transactionReference: input.reference,
        refundReference: providerReference,
        refundAmount: input.amountMinor / 100,
        refundReason: input.reason || "Hook fulfilment refund",
      }),
    });
    const data = response.responseBody as Record<string, any>;
    const returned = String(data?.refundReference || providerReference);
    if (!returned) throw new HttpError(502, "Payment provider returned an invalid refund response", undefined, "PAYMENT_PROVIDER_ERROR");
    return { providerReference: returned };
  }

  /** Finds a refund previously created for this key, or undefined if none exists. */
  async lookupRefund(input: { reference: string; amountMinor: number; idempotencyKey: string }) {
    this.assertDisbursementEnabled();
    const providerReference = `hook-refund-${input.idempotencyKey}`;
    const response = await this.request(`/api/v1/refunds/${encodeURIComponent(providerReference)}`, { method: "GET" }).catch(() => undefined);
    const data = response?.responseBody as Record<string, any> | undefined;
    if (!data) return undefined;
    const status = String(data?.refundStatus || "").toUpperCase();
    if (["FAILED", "REJECTED"].includes(status)) return undefined;
    if (Number(data?.refundAmount) !== input.amountMinor / 100) return undefined;
    return { providerReference: String(data?.refundReference || providerReference) };
  }

  isSuccessEvent(eventType: string) {
    return eventType === "SUCCESSFUL_TRANSACTION";
  }

  parseWebhook(rawBody: Buffer, signature: string) {
    // Monnify signs clientSecret + rawBody as one string, SHA-512 hashed (not HMAC-keyed).
    const digest = createHash("sha512").update(`${this.secretKey()}${rawBody.toString("utf8")}`).digest("hex");
    const supplied = String(signature || "").toLowerCase();
    if (digest.length !== supplied.length || !timingSafeEqual(Buffer.from(digest), Buffer.from(supplied)))
      throw new HttpError(401, "Invalid webhook signature", undefined, "WEBHOOK_SIGNATURE_INVALID");
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid webhook payload");
    }
    const data = payload.eventData || {};
    const reference = data.paymentReference ? String(data.paymentReference) : undefined;
    const providerEventId = String(
      payload.transactionReference || data.transactionReference || `${payload.eventType || "unknown"}:${reference || createHash("sha256").update(rawBody).digest("hex")}`,
    );
    return {
      eventType: String(payload.eventType || ""),
      providerEventId,
      reference,
      payload,
    };
  }

  private async request(path: string, init: RequestInit) {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(503, "Payment provider is temporarily unavailable", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok || body.requestSuccessful !== true)
      throw new HttpError(502, "Payment provider could not process the request", { httpStatus: response.status }, "PAYMENT_PROVIDER_ERROR");
    return body;
  }
}
