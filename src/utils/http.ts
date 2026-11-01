import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'ACCOUNT_PORTAL_MISMATCH'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_INVALID'
  | 'ACCESS_DENIED'
  | 'SCOPE_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'RUNNER_MARKET_ASSIGNMENT_REQUIRED'
  | 'MARKET_INACTIVE'
  | 'SUBMISSION_STATE_CONFLICT'
  | 'SUBMISSION_VALIDATION_FAILED'
  | 'SUBMISSION_REVIEW_CONFLICT'
  | 'PRODUCT_PUBLICATION_REQUIREMENTS_NOT_MET'
  | 'PRODUCT_PRICING_INVALID'
  | 'NEGOTIATION_DISABLED'
  | 'ACTIVE_NEGOTIATION_EXISTS'
  | 'NEGOTIATION_EXPIRED'
  | 'OFFER_LIMIT_REACHED'
  | 'QUOTE_EXPIRED'
  | 'NEGOTIATION_OFFER_LIMIT_REACHED'
  | 'NEGOTIATION_QUOTE_EXPIRED'
  | 'NEGOTIATION_OWNERSHIP_REQUIRED'
  | 'OPENAI_PROVIDER_UNAVAILABLE'
  | 'NEGOTIATION_UNAVAILABLE'
  | 'NEGOTIATION_COMMAND_IN_PROGRESS'
  | 'MEDIA_PROVIDER_UNAVAILABLE'
  | 'PRICING_BOUNDARY_VIOLATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ACTION_IN_PROGRESS'
  | 'STATE_SCOPE_DENIED'
  | 'STALE_VERSION'
  | 'PRODUCT_NOT_AVAILABLE'
  | 'PRODUCT_VARIANT_UNAVAILABLE'
  | 'EMAIL_VERIFICATION_REQUIRED'
  | 'ADDRESS_OUTSIDE_COVERAGE'
  | 'ADDRESS_STATE_MISMATCH'
  | 'ADDRESS_LGA_MISMATCH'
  | 'CHECKOUT_STATE_UNAVAILABLE'
  | 'CHECKOUT_PREVIEW_INVALID'
  | 'CHECKOUT_PREVIEW_EXPIRED'
  | 'CHECKOUT_REVALIDATION_REQUIRED'
  | 'CART_EMPTY'
  | 'CART_VERSION_CHANGED'
  | 'POLICY_ACCEPTANCE_REQUIRED'
  | 'PAYMENT_METHOD_NOT_ALLOWED'
  | 'DELIVERY_METHOD_NOT_ALLOWED'
  | 'PAYMENT_INITIALIZATION_NOT_ALLOWED'
  | 'PAYMENT_PROVIDER_UNAVAILABLE'
  | 'COUPON_INVALID'
  | 'COUPON_INACTIVE'
  | 'COUPON_NOT_STARTED'
  | 'COUPON_EXPIRED'
  | 'COUPON_MINIMUM_NOT_MET'
  | 'COUPON_EXHAUSTED'
  | 'COUPON_ALREADY_USED'
  | 'CREDIT_BALANCE_CHANGED'
  | 'LOGISTICS_PROVIDER_UNAVAILABLE'
  | 'LOGISTICS_PROVIDER_REQUIRED'
  | 'LOGISTICS_PROVIDER_ERROR'
  | 'CREDITS_REQUIRE_PREPAYMENT'
  | 'MINIMUM_ORDER_NOT_MET'
  | 'PAYMENT_PROVIDER_ERROR'
  | 'PAYMENT_PROVIDER_NOT_SUPPORTED'
  | 'PAYMENT_CONFIGURATION_ERROR'
  | 'PAYMENT_ALREADY_CONFIRMED'
  | 'PAYMENT_ATTEMPT_IN_PROGRESS'
  | 'PAYMENT_LINK_EXPIRED'
  | 'FULFILMENT_GROUP_REQUIRED'
  | 'PAYMENT_RECORD_MISSING'
  | 'PAYMENT_EVIDENCE_MISMATCH'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'ORDER_NOT_COMPLETE'
  | 'HUB_MISMATCH'
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_NOT_CAPTURED'
  | 'PROVIDER_NOT_READY'
  | 'CUSTODY_EXPIRED'
  | 'RETURN_WINDOW_CLOSED'
  | 'REFUND_LIMIT_EXCEEDED'
  | 'MARKET_VENDOR_INVALID'
  | 'MARKET_VENDOR_REQUIRED'
  | 'MARKET_VENDOR_DUPLICATE'
  | 'VENDOR_COLLECTION_EXISTS'
  | 'VENDOR_PAYMENT_MISSING'
  | 'AVAILABILITY_CHECK_NOT_PENDING'
  | 'ITEMS_NOT_VERIFIED'
  | 'ITEMS_NOT_CONFIRMED'
  | 'TOO_MANY_ATTEMPTS'
  | 'ACCOUNT_DELETION_IN_PROGRESS'
  | 'ACCOUNT_DELETION_BLOCKED'
  | 'ACCOUNT_DELETION_SCHEDULED'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'DOWNSTREAM_FAILED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'OPERATION_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REQUIRED'

/** True for a MongoDB duplicate-key (E11000) error, i.e. a unique index rejected the write. */
export function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === 11000;
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    public code: ErrorCode = statusCode === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR',
  ) {
    super(message);
  }
}

function responseMeta(requestId: string, pagination?: Record<string, number>) {
  return {
    requestId,
    timestamp: new Date().toISOString(),
    ...(pagination ? { pagination } : {}),
  };
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const requestId = req.header('x-request-id')?.trim() || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

function extractPagination(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;
  const value = data as Record<string, unknown>;
  if (![value.page, value.limit, value.total, value.totalPages].every((item) => typeof item === 'number')) {
    return undefined;
  }
  return {
    page: value.page as number,
    limit: value.limit as number,
    total: value.total as number,
    totalPages: value.totalPages as number,
  };
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function sendSuccess<T>(res: Response, data: T, message?: string) {
  const req = res.req;
  res.json({
    success: true,
    ...(message ? { message } : {}),
    data,
    meta: responseMeta(req.requestId || randomUUID(), extractPagination(data)),
  });
}

export function sendCreated<T>(res: Response, data: T, message?: string) {
  const req = res.req;
  res.status(201).json({
    success: true,
    ...(message ? { message } : {}),
    data,
    meta: responseMeta(req.requestId || randomUUID(), extractPagination(data)),
  });
}

export function sendError(
  res: Response,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    meta: responseMeta(res.req.requestId || randomUUID()),
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const httpError = err instanceof HttpError ? err : null;
  const statusCode = httpError?.statusCode || 500;
  const message = httpError?.message || 'Internal server error';

  if (statusCode >= 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code: httpError?.code || 'INTERNAL_ERROR',
      message,
      ...(httpError?.details === undefined ? {} : { details: httpError.details }),
    },
    meta: responseMeta(_req.requestId || randomUUID()),
  });
}
