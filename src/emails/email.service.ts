import {
  AccountActivatedEmailPayload,
  AccountDeletionEmailPayload,
  AccountInvitationEmailPayload,
  AvailabilityDigestEmailPayload,
  CustomerAccountSetupEmailPayload,
  EmailMessage,
  NegotiationAcceptedEmailPayload,
  NegotiationOfferEmailPayload,
  OrderCancelledEmailPayload,
  OrderEmailPayload,
  OtpEmailPayload,
  PaymentConfirmedEmailPayload,
  RefundEmailPayload,
  BroadcastMessageEmailPayload,
  SubmissionDecisionEmailPayload,
  VendorDecisionEmailPayload,
  WaitlistMessageEmailPayload,
  WelcomeEmailPayload,
} from './email.types';
import {
  accountActivatedEmailTemplate,
  accountDeletionEmailTemplate,
  accountInvitationEmailTemplate,
  availabilityDigestEmailTemplate,
  customerAccountSetupEmailTemplate,
  hookNewOrderEmailTemplate,
  negotiationAcceptedEmailTemplate,
  negotiationOfferEmailTemplate,
  orderCancelledEmailTemplate,
  orderConfirmationEmailTemplate,
  orderStatusUpdateEmailTemplate,
  orderAwaitingPaymentEmailTemplate,
  otpEmailTemplate,
  passwordResetEmailTemplate,
  paymentConfirmedEmailTemplate,
  refundIssuedEmailTemplate,
  settlementUpdateEmailTemplate,
  submissionDecisionEmailTemplate,
  setResolvedEmailSettings,
  vendorApprovedEmailTemplate,
  vendorNewOrderEmailTemplate,
  vendorRejectedEmailTemplate,
  broadcastMessageEmailTemplate,
  waitlistMessageEmailTemplate,
  welcomeEmailTemplate,
} from './templates';
import { getEmailSettings } from '@modules/notifications/email-settings.service';

type BrevoSendResponse = {
  code?: string;
  message?: string;
  messageId?: string;
};

type BrevoSender = {
  active?: boolean;
  email?: string;
};

type BrevoSendersResponse = {
  senders?: BrevoSender[];
};

function isBrevoConfigured() {
  const key = process.env.BREVO_API_KEY;
  return Boolean(key && !key.includes('placeholder'));
}

export async function isActiveBrevoSender(email: string) {
  if (!isBrevoConfigured()) return false;

  const response = await fetch('https://api.brevo.com/v3/senders', {
    headers: {
      accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY!,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Brevo sender check failed with status ${response.status}`);

  const data = await response.json() as BrevoSendersResponse;
  const normalizedEmail = email.trim().toLowerCase();
  return Boolean(data.senders?.some((sender) => (
    sender.active && sender.email?.trim().toLowerCase() === normalizedEmail
  )));
}

export class EmailService {
  /**
   * Pulls the admin-configurable settings (support email, app name/URL, etc.)
   * into templates.ts's module-level cache before any render*Template() call
   * runs, so baseValues() picks them up without needing to be async itself.
   */
  private async loadSettings() {
    const settings = await getEmailSettings();
    setResolvedEmailSettings(settings);
    return settings;
  }

  async send(message: EmailMessage) {
    if (!isBrevoConfigured()) {
      console.log(`[email:dev] ${message.to} - ${message.subject}`);
      return { delivered: false, provider: 'console' };
    }

    const settings = await getEmailSettings();
    const fromEmail = settings.brevoFromEmail;
    if (!fromEmail) {
      console.warn('[email:brevo] No sender email configured (BREVO_FROM_EMAIL or admin Email Configuration). Falling back to console provider.');
      console.log(`[email:dev] ${message.to} - ${message.subject}`);
      return { delivered: false, provider: 'console' };
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': process.env.BREVO_API_KEY!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: {
          email: fromEmail,
          name: settings.brevoFromName,
        },
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await response.json().catch(() => ({} as BrevoSendResponse));
    if (!response.ok) {
      console.error(JSON.stringify({
        event: 'brevo_email_rejected',
        status: response.status,
        providerCode: data.code,
        providerMessage: data.message,
      }));
      throw new Error('Email provider failed to send message');
    }

    console.log(`[email:brevo] Sent to ${message.to} (${data.messageId || 'queued'})`);
    return { delivered: true, provider: 'brevo', messageId: data.messageId };
  }

  async sendOtp(payload: OtpEmailPayload) {
    await this.loadSettings();
    const template = payload.purpose === 'password_reset'
      ? passwordResetEmailTemplate(payload)
      : otpEmailTemplate(payload);
    return this.send({
      to: payload.email,
      ...template,
    });
  }

  async sendWelcome(payload: WelcomeEmailPayload) {
    await this.loadSettings();
    const template = welcomeEmailTemplate(payload);
    return this.send({ to: payload.email, ...template });
  }

  async sendWaitlistMessage(payload: WaitlistMessageEmailPayload) {
    await this.loadSettings();
    const template = waitlistMessageEmailTemplate(payload);
    return this.send({ to: payload.email, ...template });
  }

  async sendBroadcastMessage(payload: BroadcastMessageEmailPayload) {
    await this.loadSettings();
    const template = broadcastMessageEmailTemplate(payload);
    return this.send({ to: payload.email, ...template });
  }

  async sendAccountInvitation(payload: AccountInvitationEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.email, ...accountInvitationEmailTemplate(payload) });
  }

  async sendCustomerAccountSetup(payload: CustomerAccountSetupEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.email, ...customerAccountSetupEmailTemplate(payload) });
  }

  async sendOrderConfirmation(payload: OrderEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...orderConfirmationEmailTemplate(payload) });
  }

  async sendVendorNewOrder(payload: OrderEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...vendorNewOrderEmailTemplate(payload) });
  }

  async sendHookNewOrder(payload: OrderEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...hookNewOrderEmailTemplate(payload) });
  }

  async sendOrderStatusUpdate(payload: OrderEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...orderStatusUpdateEmailTemplate(payload) });
  }

  async sendOrderAwaitingPayment(payload: OrderEmailPayload & { paymentUrl: string }) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...orderAwaitingPaymentEmailTemplate(payload) });
  }

  async sendVendorApproved(payload: VendorDecisionEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...vendorApprovedEmailTemplate(payload) });
  }

  async sendVendorRejected(payload: VendorDecisionEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...vendorRejectedEmailTemplate(payload) });
  }

  async sendSettlementUpdate(payload: OrderEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...settlementUpdateEmailTemplate(payload) });
  }

  async sendOrderCancelled(payload: OrderCancelledEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...orderCancelledEmailTemplate(payload) });
  }

  async sendPaymentConfirmed(payload: PaymentConfirmedEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...paymentConfirmedEmailTemplate(payload) });
  }

  async sendRefundIssued(payload: RefundEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...refundIssuedEmailTemplate(payload) });
  }

  async sendNegotiationOffer(payload: NegotiationOfferEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...negotiationOfferEmailTemplate(payload) });
  }

  async sendNegotiationAccepted(payload: NegotiationAcceptedEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...negotiationAcceptedEmailTemplate(payload) });
  }

  async sendSubmissionDecision(payload: SubmissionDecisionEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...submissionDecisionEmailTemplate(payload) });
  }

  async sendAccountActivated(payload: AccountActivatedEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.email, ...accountActivatedEmailTemplate(payload) });
  }

  async sendAccountDeletion(payload: AccountDeletionEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.email, ...accountDeletionEmailTemplate(payload) });
  }

  async sendAvailabilityDigest(payload: AvailabilityDigestEmailPayload) {
    await this.loadSettings();
    return this.send({ to: payload.to, ...availabilityDigestEmailTemplate(payload) });
  }
}
