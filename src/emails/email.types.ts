export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface OtpEmailPayload {
  email: string;
  code: string;
  name?: string;
  purpose?: 'verification' | 'password_reset';
  expiresInMinutes?: number;
}

export interface WelcomeEmailPayload {
  email: string;
  name?: string;
}

export interface WaitlistMessageEmailPayload {
  email: string;
  name?: string;
  subject: string;
  message: string;
  unsubscribeUrl: string;
}

export interface BroadcastMessageEmailPayload {
  email: string;
  name?: string;
  subject: string;
  message: string;
}

export interface AccountInvitationEmailPayload {
  email: string;
  name: string;
  accountType: string;
  activationUrl: string;
  expiresInHours: number;
}

export interface CustomerAccountSetupEmailPayload {
  email: string;
  name: string;
  partnerName: string;
  activationUrl: string;
  expiresInHours: number;
}

export interface OrderEmailLine {
  title: string;
  quantity: number;
  amount: number;
  /** Absolute URL. Omitted lines fall back to a neutral placeholder cell. */
  imageUrl?: string;
}

export interface OrderEmailPayload {
  to: string;
  name?: string;
  orderCode: string;
  amount: number;
  itemCount?: number;
  customerName?: string;
  vendorName?: string;
  status?: string;
  /** One line explaining what is happening, from customerStatusDetail(). */
  detail?: string;
  dashboardUrl?: string;
  /** Optional itemised recap. Falls back to the summary rows when absent. */
  lines?: OrderEmailLine[];
  subtotal?: number;
  deliveryFee?: number;
  discount?: number;
  deliveryAddress?: string;
  expectedDeliveryDate?: string;
}

export interface VendorDecisionEmailPayload {
  to: string;
  vendorName: string;
  reason?: string;
}

export interface OrderCancelledEmailPayload {
  to: string;
  name?: string;
  orderCode: string;
  amount: number;
  reason?: string;
}

export interface PaymentConfirmedEmailPayload {
  to: string;
  name?: string;
  orderCode: string;
  amount: number;
}

export interface RefundEmailPayload {
  to: string;
  name?: string;
  orderCode: string;
  amountMinor: number;
  currency?: string;
  fullyRefunded: boolean;
}

export interface NegotiationOfferEmailPayload {
  to: string;
  name?: string;
  productTitle: string;
  counterPriceMinor: number;
  expiresAt: string | Date;
}

export interface NegotiationAcceptedEmailPayload {
  to: string;
  name?: string;
  productTitle: string;
  agreedPriceMinor: number;
  quoteExpiresAt: string | Date;
}

export interface SubmissionDecisionEmailPayload {
  to: string;
  name?: string;
  productTitle: string;
  decision: 'approved' | 'rejected' | 'changes_requested';
  reason?: string;
}

export interface AccountActivatedEmailPayload {
  email: string;
  name?: string;
  accountType: string;
}

export interface AvailabilityDigestEmailPayload {
  to: string;
  name?: string;
  products: Array<{ title: string; marketName: string }>;
}

export type AccountDeletionEmailKind = 'code' | 'scheduled' | 'reminder' | 'deleted' | 'restored';

export interface AccountDeletionEmailPayload {
  email: string;
  kind: AccountDeletionEmailKind;
  name?: string;
  /** Human-readable date erasure is scheduled for. */
  scheduledFor?: string;
  /** One-click link that cancels the deletion. */
  cancelUrl?: string;
  code?: string;
  expiresInMinutes?: number;
}
