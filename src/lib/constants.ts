// ============================================================
// Role constants — maps directly to user.role column
// ============================================================
export enum UserRole {
  SHOPPER = 'shopper',
  MARKETASSOCIATE = 'marketassociate',
  PARTNER = 'partner',
  VENDOR = 'vendor',
  SUPPORT = 'support',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

export enum AccountType {
  CUSTOMER = 'customer',
  STAFF = 'staff',
  MARKETASSOCIATE = 'marketassociate',
  PARTNER = 'partner',
}

export enum AccountStatus {
  INVITED = 'invited',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DISABLED = 'disabled',
  PENDING_PASSWORD = 'pending_password',
  DELETION_REQUESTED = 'deletion_requested',
  ANONYMIZED = 'anonymized',
}

export enum ScopeType {
  GLOBAL = 'global',
  MULTI_STATE = 'multi_state',
  SINGLE_STATE = 'single_state',
  HUB = 'hub',
  SELF = 'self',
}

export const PLATFORM_ROLE_KEYS = [
  'SUPER_ADMIN',
  'OPERATIONS_LEAD',
  'STATE_OPERATIONS_MANAGER',
  'COMMERCIAL_MANAGER',
  'COMMERCIAL_OFFICER',
  'CATALOG_REVIEWER',
  'DISPATCH_HUB_MANAGER',
  'DISPATCH_HUB_OFFICER',
  'LOGISTICS_OFFICER',
  'CUSTOMER_SUPPORT_OFFICER',
  'FINANCE_OFFICER',
  'MANAGEMENT_VIEWER',
] as const;

export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number];

// ============================================================
// Order lifecycle
// ============================================================
export enum OrderStatus {
  VERIFICATION_PENDING = 'verification_pending',
  OPERATIONS_REVIEW = 'operations_review',
  APPROVED_FOR_FULFILMENT = 'approved_for_fulfilment',
  AWAITING_PAYMENT = 'awaiting_payment',
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  RETURNED = 'returned',
  REFUNDED = 'refunded',
}

export enum CommercePaymentMethod {
  PREPAID = 'PREPAID',
}

export enum CommercePaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  REFUND_PENDING = 'REFUND_PENDING',
  REFUNDED = 'REFUNDED',
}

export enum CommerceOrderStatus {
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  VERIFICATION_PENDING = 'VERIFICATION_PENDING',
  OPERATIONS_REVIEW = 'OPERATIONS_REVIEW',
  APPROVED_FOR_FULFILMENT = 'APPROVED_FOR_FULFILMENT',
  IN_FULFILMENT = 'IN_FULFILMENT',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  READY_FOR_CONSOLIDATION = 'READY_FOR_CONSOLIDATION',
  READY_FOR_DISPATCH = 'READY_FOR_DISPATCH',
  IN_TRANSIT = 'IN_TRANSIT',
  PARTIALLY_IN_TRANSIT = 'PARTIALLY_IN_TRANSIT',
  PARTIALLY_DELIVERED = 'PARTIALLY_DELIVERED',
  DELIVERED = 'DELIVERED',
  COLLECTED = 'COLLECTED',
  COMPLETED = 'COMPLETED',
  ON_HOLD = 'ON_HOLD',
  RETURN_IN_PROGRESS = 'RETURN_IN_PROGRESS',
  REFUNDED = 'REFUNDED',
  CANCELLED = 'CANCELLED',
}

export enum FulfilmentTaskStatus {
  UNASSIGNED = 'UNASSIGNED',
  ALERTED = 'ALERTED',
  ACCEPTED = 'ACCEPTED',
  SOURCING = 'SOURCING',
  PRODUCT_SECURED = 'PRODUCT_SECURED',
  PACKING = 'PACKING',
  READY_FOR_HUB = 'READY_FOR_HUB',
  HUB_RECEIVED = 'HUB_RECEIVED',
  QC_PASSED = 'QC_PASSED',
  QC_FAILED = 'QC_FAILED',
  COMPLETED = 'COMPLETED',
  BLOCKED = 'BLOCKED',
  CANCELLED = 'CANCELLED',
}

export enum RunnerPackageStatus {
  READY_FOR_HUB = 'READY_FOR_HUB',
  HUB_RECEIVED = 'HUB_RECEIVED',
  QC_FAILED = 'QC_FAILED',
  QC_PASSED = 'QC_PASSED',
  CONSOLIDATED = 'CONSOLIDATED',
  RETURNED = 'RETURNED',
}

export enum HubPackageStatus {
  RECEIVED = 'RECEIVED',
  QC_PENDING = 'QC_PENDING',
  QC_PASSED = 'QC_PASSED',
  QC_FAILED = 'QC_FAILED',
  CONSOLIDATED = 'CONSOLIDATED',
  RETURNED = 'RETURNED',
}

export enum ShipmentStatus {
  READY_FOR_BOOKING = 'READY_FOR_BOOKING',
  BOOKING_PENDING = 'BOOKING_PENDING',
  BOOKED_WITH_PROVIDER = 'BOOKED_WITH_PROVIDER',
  AWAITING_PICKUP = 'AWAITING_PICKUP',
  PICKED_UP = 'PICKED_UP',
  IN_TRANSIT = 'IN_TRANSIT',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  DELIVERED = 'DELIVERED',
  DELIVERY_FAILED = 'DELIVERY_FAILED',
  RETURN_IN_TRANSIT = 'RETURN_IN_TRANSIT',
  RETURNED_TO_HOOK = 'RETURNED_TO_HOOK',
  CANCELLED = 'CANCELLED',
}

export enum CommerceChannel {
  SHOPPER_APP = 'SHOPPER_APP',
  PARTNER_ASSISTED = 'PARTNER_ASSISTED',
}

export enum DeliveryMethod {
  HOME_DELIVERY = 'HOME_DELIVERY',
  PARTNER_PICKUP = 'PARTNER_PICKUP',
}

export enum PaymentMode {
  PAY_NOW = 'pay_now',
}

export enum OrderType {
  STANDARD = 'standard',
  GIFT = 'gift',
}

/** @deprecated Vendor fulfilment is retained for historical records only. */
export enum VendorFulfilmentStatus {
  AWAITING_CONFIRMATION = 'awaiting_confirmation',
  CONFIRMED = 'confirmed',
  REJECTED = 'rejected',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}

export enum EscrowEventType {
  PAYMENT_RECEIVED = 'payment_received',
  HELD = 'held',
  PARTIALLY_REFUNDED = 'partially_refunded',
  REFUND_PENDING = 'refund_pending',
  ELIGIBLE_FOR_PAYOUT = 'eligible_for_payout',
  PAID_OUT = 'paid_out',
  DISPUTED = 'disputed',
}

export enum PaymentStatus {
  UNPAID = 'unpaid',
  PENDING = 'pending',
  SUCCESSFUL = 'successful',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
}

export enum NegotiationStatus {
  ACTIVE = 'active',
  AGREED = 'agreed',
  /** @deprecated Retained while legacy negotiation records are migrated. */
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  EXPIRED = 'expired',
  CLOSED = 'closed',
  WITHDRAWN = 'withdrawn',
}

export enum LogisticsStatus {
  ASSIGNED = 'assigned',
  DRIVER_ACKNOWLEDGED = 'driver_acknowledged',
  AT_PICKUP = 'at_pickup',
  ITEM_PACKED = 'item_packed',
  QR_TAGGED = 'qr_tagged',
  IN_TRANSIT = 'in_transit',
  DELIVERED = 'delivered',
  FAILED = 'failed',
}

export enum ProductStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  PAUSED = 'paused',
  AVAILABILITY_UNCONFIRMED = 'availability_unconfirmed',
  UNPUBLISHED = 'unpublished',
  /** @deprecated Legacy catalog workflow status. */
  PENDING_APPROVAL = 'pending_approval',
  /** @deprecated Legacy published status. */
  APPROVED = 'approved',
  REJECTED = 'rejected',
  DISABLED = 'disabled',
  SOLD_OUT = 'sold_out',
}

export enum ProductSubmissionStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  IN_REVIEW = 'in_review',
  CHANGES_REQUESTED = 'changes_requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum ProductAvailabilityStatus {
  AVAILABLE = 'available',
  LIMITED = 'limited',
  UNAVAILABLE = 'unavailable',
  UNCONFIRMED = 'unconfirmed',
}

export enum NegotiatedQuoteStatus {
  ACTIVE = 'active',
  USED = 'used',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/** @deprecated Vendor tiers are retained for legacy product/source records. */
export enum VendorTier {
  TIER_1 = 'tier_1', // Major retailers — full IMS/API integration
  TIER_2 = 'tier_2', // Independent boutiques — vendor portal
  TIER_3 = 'tier_3', // Open market stalls — field-agent managed
}

export enum SettlementStatus {
  PENDING_ESCROW = 'pending_escrow',
  CLEARED = 'cleared',
  PAID = 'paid',
  FAILED = 'failed',
}

/** @deprecated Booth records are retained pending Hook Partner migration. */
export enum BoothType {
  PHYGITAL = 'phygital',
  MICRO_HUB = 'micro_hub',
}

// ============================================================
// Defaults
// ============================================================
export const PAGINATION_DEFAULTS = {
  PAGE: 1,
  LIMIT: 20,
  MAX_LIMIT: 100,
};

export const VENDOR_COMMISSION_PERCENTAGE = 15;
export const ESCROW_HOLD_HOURS = 24;
export const DELIVERY_SLA_HOURS = 24;
export const DEFAULT_DELIVERY_FEE = 3000;
export const DEFAULT_DELIVERY_FEE_MINOR = 300000;

export const VENDOR_CONFIRMATION_HOURS = 2;
export const GIFT_EXPIRY_DAYS = 7;
