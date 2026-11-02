import fs from 'fs';
import path from 'path';
import {
  AccountActivatedEmailPayload,
  AccountInvitationEmailPayload,
  AvailabilityDigestEmailPayload,
  AccountDeletionEmailPayload,
  CustomerAccountSetupEmailPayload,
  NegotiationAcceptedEmailPayload,
  NegotiationOfferEmailPayload,
  OrderCancelledEmailPayload,
  OrderEmailLine,
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

const templateDirs = [
  path.join(__dirname, 'templates'),
  path.join(process.cwd(), 'src', 'emails', 'templates'),
];

// Cached in memory since templates never change at runtime; avoids a synchronous disk read on every email render.
const templateFileCache = new Map<string, string>();

function readTemplateFile(fileName: string) {
  const cached = templateFileCache.get(fileName);
  if (cached !== undefined) return cached;
  for (const dir of templateDirs) {
    const file = path.join(dir, fileName);
    if (fs.existsSync(file)) {
      const contents = fs.readFileSync(file, 'utf8');
      templateFileCache.set(fileName, contents);
      return contents;
    }
  }
  throw new Error(`Email template not found: ${fileName}`);
}

const emailStyles = readTemplateFile('base.css');

/** Set once per send by EmailService from the DB-backed Email Configuration settings, kept as a module variable so baseValues() stays synchronous. */
let resolvedEmailSettings: { appName?: string; appUrl?: string; supportEmail?: string } = {};

export function setResolvedEmailSettings(values: { appName?: string; appUrl?: string; supportEmail?: string }) {
  resolvedEmailSettings = values;
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function money(value = 0) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function renderTemplate(fileName: string, values: Record<string, unknown>) {
  const html = readTemplateFile(fileName);
  return html
    // Triple braces inject trusted, internally-generated markup; never use this for user-supplied values.
    .replace(/\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}/g, (_match, key) => String(values[key] ?? ''))
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
      if (key === 'emailStyles') return emailStyles;
      return escapeHtml(values[key]);
    });
}

/** Builds the itemised recap rows; every value is escaped since the result is injected raw via the triple-brace token. */
function orderLinesHtml(lines?: OrderEmailLine[]) {
  if (!lines?.length) return '';
  // Laid out as a table, not flex: Outlook and several webmail clients drop flex entirely and would stack the thumbnail above the title.
  return lines
    .map((line) => {
      const thumb = line.imageUrl
        ? `<img class="line-thumb" src="${escapeHtml(line.imageUrl)}" alt="" width="48" height="48">`
        : '<span class="line-thumb line-thumb-empty">&nbsp;</span>';
      return `<table class="line-item" role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>`
        + `<td class="line-thumb-cell" width="48">${thumb}</td>`
        + `<td class="line-text-cell"><span class="line-title">${escapeHtml(line.title)}</span><br><span class="line-qty">Quantity ${escapeHtml(line.quantity)}</span></td>`
        + `<td class="line-price-cell" align="right"><span class="line-price">${escapeHtml(money(line.amount))}</span></td>`
        + `</tr></table>`;
    })
    .join('');
}

/** Optional summary rows, omitted entirely when the caller has no value. */
function optionalRowHtml(label: string, value?: number) {
  if (value === undefined || value === null) return '';
  return `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(money(value))}</span></div>`;
}

/** The dark delivery block, rendered whole or not at all since the template engine only substitutes values and has no conditionals. */
function deliveryBlockHtml(payload: { deliveryAddress?: string; expectedDeliveryDate?: string; appUrl: string }) {
  if (!payload.deliveryAddress && !payload.expectedDeliveryDate) return '';
  const columns = [
    payload.deliveryAddress
      ? `<div class="dark-col"><div class="dark-heading">Shipping to</div><div class="dark-value">${escapeHtml(payload.deliveryAddress)}</div></div>`
      : '',
    payload.expectedDeliveryDate
      ? `<div class="dark-col"><div class="dark-heading">Expected delivery</div><div class="dark-value">${escapeHtml(payload.expectedDeliveryDate)}</div></div>`
      : '',
  ].join('');
  return `<div class="dark-block"><div class="dark-cols">${columns}</div><p style="text-align:center"><a class="button button-light" href="${escapeHtml(payload.appUrl)}">Track your order</a></p></div>`;
}

function baseValues(values: Record<string, unknown> = {}) {
  return {
    appName: resolvedEmailSettings.appName || process.env.APP_NAME || 'Hook',
    appUrl: resolvedEmailSettings.appUrl || process.env.APP_URL || 'http://localhost:3000',
    supportEmail: resolvedEmailSettings.supportEmail || process.env.SUPPORT_EMAIL || process.env.BREVO_FROM_EMAIL || 'support@hook.africa',
    year: new Date().getFullYear(),
    ...values,
  };
}

export function otpEmailTemplate(payload: OtpEmailPayload) {
  const expires = payload.expiresInMinutes || Number(process.env.OTP_EXPIRY_MINUTES || 10);
  return {
    subject: 'Your Hook verification code',
    html: renderTemplate('otp.html', baseValues({
      name: payload.name || 'there',
      code: payload.code,
      title: 'Your one time password (OTP) is',
      intro: 'Use this code to verify your email address and continue with Hook.',
      expiresIn: `${expires} minutes`,
    })),
    text: `Your Hook verification code is ${payload.code}. It expires in ${expires} minutes.`,
  };
}

export function passwordResetEmailTemplate(payload: OtpEmailPayload) {
  const expires = payload.expiresInMinutes || Number(process.env.OTP_EXPIRY_MINUTES || 10);
  return {
    subject: 'Reset your Hook password',
    html: renderTemplate('password-reset.html', baseValues({
      name: payload.name || 'there',
      code: payload.code,
      expiresIn: `${expires} minutes`,
    })),
    text: `Use ${payload.code} to reset your Hook password. It expires in ${expires} minutes.`,
  };
}

export function welcomeEmailTemplate(payload: WelcomeEmailPayload) {
  return {
    subject: 'Welcome to Hook',
    html: renderTemplate('welcome.html', baseValues({ name: payload.name || 'there' })),
    text: `Welcome to Hook${payload.name ? `, ${payload.name}` : ''}.`,
  };
}

/** An admin-composed message to a waitlist entry; the free-text body is escaped and turned into paragraphs rather than trusted as HTML. */
export function waitlistMessageEmailTemplate(payload: WaitlistMessageEmailPayload) {
  const messageHtml = payload.message
    .split(/\n{2,}/)
    .map((paragraph) => `<p class="lead">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    subject: payload.subject,
    html: renderTemplate('waitlist-message.html', baseValues({
      name: payload.name || 'there',
      subject: payload.subject,
      messageHtml,
      unsubscribeUrl: payload.unsubscribeUrl,
    })),
    text: `${payload.message}\n\nNo longer want these emails? Unsubscribe: ${payload.unsubscribeUrl}`,
  };
}

/** An admin-composed message to an existing account (Communications page) — no unsubscribe link, since this only reaches accounts that already exist, not a marketing list. */
export function broadcastMessageEmailTemplate(payload: BroadcastMessageEmailPayload) {
  const messageHtml = payload.message
    .split(/\n{2,}/)
    .map((paragraph) => `<p class="lead">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    subject: payload.subject,
    html: renderTemplate('broadcast-message.html', baseValues({
      name: payload.name || 'there',
      subject: payload.subject,
      messageHtml,
    })),
    text: payload.message,
  };
}

export function accountInvitationEmailTemplate(payload: AccountInvitationEmailPayload) {
  return {
    subject: 'Activate your Hook account',
    html: renderTemplate('account-invitation.html', baseValues({
      name: payload.name || 'there',
      accountType: payload.accountType,
      activationUrl: payload.activationUrl,
      expiresIn: `${payload.expiresInHours} hours`,
    })),
    text: `Activate your Hook ${payload.accountType} account: ${payload.activationUrl}. This link expires in ${payload.expiresInHours} hours.`,
  };
}

export function customerAccountSetupEmailTemplate(payload: CustomerAccountSetupEmailPayload) {
  return {
    subject: 'Set your Hook password',
    html: renderTemplate('customer-account-setup.html', baseValues({
      name: payload.name || 'there',
      email: payload.email,
      partnerName: payload.partnerName,
      activationUrl: payload.activationUrl,
      expiresIn: `${payload.expiresInHours} hours`,
    })),
    text: `${payload.partnerName} started an order for you on Hook. Set your password: ${payload.activationUrl}. This link expires in ${payload.expiresInHours} hours.`,
  };
}

export function orderConfirmationEmailTemplate(payload: OrderEmailPayload) {
  return {
    subject: `Hook order received: ${payload.orderCode}`,
    html: renderTemplate('order-confirmation.html', baseValues({
      name: payload.name || 'there',
      orderCode: payload.orderCode,
      amount: money(payload.amount),
      itemCount: payload.itemCount || 0,
      lines: orderLinesHtml(payload.lines),
      subtotalRow: optionalRowHtml('Subtotal', payload.subtotal),
      discountRow: optionalRowHtml('Discount', payload.discount),
      deliveryRow: optionalRowHtml('Delivery', payload.deliveryFee),
      deliveryBlock: deliveryBlockHtml({
        deliveryAddress: payload.deliveryAddress,
        expectedDeliveryDate: payload.expectedDeliveryDate,
        appUrl: resolvedEmailSettings.appUrl || process.env.APP_URL || 'http://localhost:3000',
      }),
    })),
    text: `Your Hook order ${payload.orderCode} has been received. Total: ${money(payload.amount)}.`,
  };
}

export function vendorNewOrderEmailTemplate(payload: OrderEmailPayload) {
  return {
    subject: `New Hook order for ${payload.vendorName || 'your store'}`,
    html: renderTemplate('vendor-new-order.html', baseValues({
      name: payload.name || payload.vendorName || 'there',
      vendorName: payload.vendorName || 'your store',
      customerName: payload.customerName || 'Customer',
      orderCode: payload.orderCode,
      amount: money(payload.amount),
      itemCount: payload.itemCount || 0,
      dashboardUrl: payload.dashboardUrl || `${process.env.APP_URL || 'http://localhost:3000'}/dashboard/orders`,
    })),
    text: `New Hook order ${payload.orderCode} for ${money(payload.amount)}.`,
  };
}

export function hookNewOrderEmailTemplate(payload: OrderEmailPayload) {
  return {
    subject: `New marketplace order: ${payload.orderCode}`,
    html: renderTemplate('hook-new-order.html', baseValues({
      name: payload.name || 'Hook Ops',
      customerName: payload.customerName || 'Customer',
      orderCode: payload.orderCode,
      amount: money(payload.amount),
      itemCount: payload.itemCount || 0,
      dashboardUrl: payload.dashboardUrl || `${process.env.APP_URL || 'http://localhost:3000'}/dashboard/orders`,
    })),
    text: `New marketplace order ${payload.orderCode} for ${money(payload.amount)}.`,
  };
}

/** Sent when a payment link is created, so a customer who abandons checkout still has the link in their inbox. */
export function orderAwaitingPaymentEmailTemplate(payload: OrderEmailPayload & { paymentUrl: string }) {
  return {
    subject: `Complete your payment for ${payload.orderCode}`,
    html: renderTemplate('order-awaiting-payment.html', baseValues({
      name: payload.name || 'there',
      orderCode: payload.orderCode,
      amount: money(payload.amount),
      paymentUrl: payload.paymentUrl,
      orderLines: orderLinesHtml(payload.lines),
    })),
    text: `Complete your payment for Hook order ${payload.orderCode} (${money(payload.amount)}): ${payload.paymentUrl}`,
  };
}

export function orderStatusUpdateEmailTemplate(payload: OrderEmailPayload) {
  return {
    subject: `Hook order update: ${payload.orderCode}`,
    html: renderTemplate('order-status-update.html', baseValues({
      name: payload.name || 'there',
      orderCode: payload.orderCode,
      status: payload.status || 'updated',
      amount: money(payload.amount),

      detailHtml: payload.detail ? `<p class="lead">${escapeHtml(payload.detail)}</p>` : '',
      orderLines: payload.lines?.length ? `<div class="panel">${orderLinesHtml(payload.lines)}</div>` : '',
    })),

    text: `Update on your Hook order ${payload.orderCode}: ${payload.status || 'updated'}.${payload.detail ? ` ${payload.detail}` : ''}`,
  };
}

export function vendorApprovedEmailTemplate(payload: VendorDecisionEmailPayload) {
  return {
    subject: 'Your Hook vendor profile is approved',
    html: renderTemplate('vendor-approved.html', baseValues({ vendorName: payload.vendorName })),
    text: `${payload.vendorName} has been approved on Hook.`,
  };
}

export function vendorRejectedEmailTemplate(payload: VendorDecisionEmailPayload) {
  return {
    subject: 'Hook vendor profile update',
    html: renderTemplate('vendor-rejected.html', baseValues({
      vendorName: payload.vendorName,
      reason: payload.reason || 'Please review your vendor details and try again.',
    })),
    text: `${payload.vendorName} was not approved. ${payload.reason || ''}`,
  };
}

export function settlementUpdateEmailTemplate(payload: OrderEmailPayload) {
  return {
    subject: `Hook settlement update: ${payload.orderCode}`,
    html: renderTemplate('settlement-update.html', baseValues({
      name: payload.name || payload.vendorName || 'there',
      orderCode: payload.orderCode,
      amount: money(payload.amount),
      status: payload.status || 'pending',
    })),
    text: `Settlement for ${payload.orderCode}: ${money(payload.amount)} is ${payload.status || 'pending'}.`,
  };
}

export function orderCancelledEmailTemplate(payload: OrderCancelledEmailPayload) {
  return {
    subject: `Hook order cancelled: ${payload.orderCode}`,
    html: renderTemplate('order-cancelled.html', baseValues({
      name: payload.name || 'there',
      orderCode: payload.orderCode,
      amount: money(payload.amount),
      reasonSuffix: payload.reason ? ` (${payload.reason})` : '',
    })),
    text: `Your Hook order ${payload.orderCode} was cancelled${payload.reason ? ` (${payload.reason})` : ''}.`,
  };
}

export function paymentConfirmedEmailTemplate(payload: PaymentConfirmedEmailPayload) {
  return {
    subject: `Hook payment confirmed: ${payload.orderCode}`,
    html: renderTemplate('payment-confirmed.html', baseValues({
      name: payload.name || 'there',
      orderCode: payload.orderCode,
      amount: money(payload.amount),
    })),
    text: `Payment confirmed for Hook order ${payload.orderCode}: ${money(payload.amount)}.`,
  };
}

export function refundIssuedEmailTemplate(payload: RefundEmailPayload) {
  return {
    subject: `Hook refund issued: ${payload.orderCode}`,
    html: renderTemplate('refund-issued.html', baseValues({
      name: payload.name || 'there',
      orderCode: payload.orderCode,
      amount: money(payload.amountMinor / 100),
      refundTitle: payload.fullyRefunded ? 'Your refund is on the way' : 'A partial refund is on the way',
    })),
    text: `A refund for Hook order ${payload.orderCode} has been issued: ${money(payload.amountMinor / 100)}.`,
  };
}

export function negotiationOfferEmailTemplate(payload: NegotiationOfferEmailPayload) {
  return {
    subject: `New counter-offer for ${payload.productTitle}`,
    html: renderTemplate('negotiation-offer.html', baseValues({
      name: payload.name || 'there',
      productTitle: payload.productTitle,
      counterPrice: money(payload.counterPriceMinor / 100),
      expiresAt: new Date(payload.expiresAt).toLocaleString('en-NG'),
    })),
    text: `Hook sent a counter-offer of ${money(payload.counterPriceMinor / 100)} for ${payload.productTitle}.`,
  };
}

export function negotiationAcceptedEmailTemplate(payload: NegotiationAcceptedEmailPayload) {
  return {
    subject: `Price locked for ${payload.productTitle}`,
    html: renderTemplate('negotiation-accepted.html', baseValues({
      name: payload.name || 'there',
      productTitle: payload.productTitle,
      agreedPrice: money(payload.agreedPriceMinor / 100),
      quoteExpiresAt: new Date(payload.quoteExpiresAt).toLocaleString('en-NG'),
    })),
    text: `Your negotiated price of ${money(payload.agreedPriceMinor / 100)} for ${payload.productTitle} is locked in.`,
  };
}

const submissionDecisionCopy: Record<SubmissionDecisionEmailPayload['decision'], { title: string; lead: string; label: string; icon: string }> = {
  approved: { title: 'Your submission was approved', lead: 'was approved and is now live on Hook.', label: 'Approved', icon: '✓' },
  rejected: { title: 'Your submission was not approved', lead: 'was not approved.', label: 'Rejected', icon: '✕' },
  changes_requested: { title: 'Changes requested on your submission', lead: 'needs a few changes before it can go live.', label: 'Changes requested', icon: '!' },
};

export function submissionDecisionEmailTemplate(payload: SubmissionDecisionEmailPayload) {
  const copy = submissionDecisionCopy[payload.decision];
  return {
    subject: `Hook submission update: ${payload.productTitle}`,
    html: renderTemplate('submission-decision.html', baseValues({
      name: payload.name || 'there',
      productTitle: payload.productTitle,
      decisionTitle: copy.title,
      decisionLead: copy.lead,
      decisionLabel: copy.label,
      decisionIcon: copy.icon,
      reason: payload.reason || 'No additional notes were provided.',
    })),
    text: `Your Hook submission for ${payload.productTitle} ${copy.lead}${payload.reason ? ` ${payload.reason}` : ''}`,
  };
}

export function accountActivatedEmailTemplate(payload: AccountActivatedEmailPayload) {
  return {
    subject: "You're all set on Hook",
    html: renderTemplate('account-activated.html', baseValues({
      name: payload.name || 'there',
      accountType: payload.accountType,
    })),
    text: `Your Hook ${payload.accountType} account is now active.`,
  };
}

/** Every value is escaped here because the result is injected raw via the triple-brace token. */
function availabilityProductRowsHtml(products: AvailabilityDigestEmailPayload['products']) {
  return products
    .map((product) => `<div class="line-item"><span class="label">${escapeHtml(product.title)}</span><span class="value">${escapeHtml(product.marketName)}</span></div>`)
    .join('');
}

export function availabilityDigestEmailTemplate(payload: AvailabilityDigestEmailPayload) {
  return {
    subject: `${payload.products.length} product${payload.products.length === 1 ? '' : 's'} need an availability check`,
    html: renderTemplate('availability-digest.html', baseValues({
      name: payload.name || 'there',
      productCount: payload.products.length,
      productRows: availabilityProductRowsHtml(payload.products),
    })),
    text: `${payload.products.length} product(s) need an availability check: ${payload.products.map((product) => `${product.title} (${product.marketName})`).join(', ')}`,
  };
}

/** One layout, five moods; every value is escaped by renderTemplate except the triple-brace blocks, built here from escaped parts. */
export function accountDeletionEmailTemplate(payload: AccountDeletionEmailPayload) {
  const date = payload.scheduledFor || 'the scheduled date';
  const cancelButton = payload.cancelUrl
    ? `<p style="text-align: center"><a class="button" href="${escapeHtml(payload.cancelUrl)}">Keep my account</a></p>`
    : '';
  const copy = {
    code: {
      subject: 'Your Hook account deletion code',
      title: 'Confirm account deletion',
      intro: 'Use this code to confirm you want to delete your Hook account. If this was not you, ignore this email and nothing will change.',
      detail: `The code expires in ${payload.expiresInMinutes || 10} minutes.`,
      safety: 'Never share this code. Hook will never ask you for it.',
      codeBlock: payload.code ? `<div class="code">${escapeHtml(payload.code)}</div>` : '',
      button: '',
      text: `Your Hook account deletion code is ${payload.code}. It expires in ${payload.expiresInMinutes || 10} minutes. If this was not you, ignore this email.`,
    },
    scheduled: {
      subject: 'Your Hook account is scheduled for deletion',
      title: 'Account deletion scheduled',
      intro: `We received a request to delete your Hook account. It will be permanently deleted on ${date}.`,
      detail: 'You can change your mind at any time before then. Just choose the button below, or sign in to the app and restore your account.',
      safety: 'If you did not make this request, choose "Keep my account" straight away and change your password.',
      codeBlock: '',
      button: cancelButton,
      text: `Your Hook account will be permanently deleted on ${date}. To keep it, open ${payload.cancelUrl || 'the Hook app and restore your account'}.`,
    },
    reminder: {
      subject: 'Your Hook account will be deleted soon',
      title: 'Deletion is coming up',
      intro: `Your Hook account is due to be permanently deleted on ${date}.`,
      detail: 'This is your last reminder. After that date your account, saved addresses and Hook credit balance cannot be recovered.',
      safety: 'If you still want to delete your account you do not need to do anything.',
      codeBlock: '',
      button: cancelButton,
      text: `Your Hook account will be permanently deleted on ${date}. To keep it, open ${payload.cancelUrl || 'the Hook app and restore your account'}.`,
    },
    deleted: {
      subject: 'Your Hook account has been deleted',
      title: 'Account deleted',
      intro: 'Your Hook account and personal data have been permanently deleted.',
      detail: 'We keep only the order and payment records the law requires us to hold, with your identity removed. Thank you for having shopped with Hook.',
      safety: 'This is the last email we will send to this address about your account.',
      codeBlock: '',
      button: '',
      text: 'Your Hook account and personal data have been permanently deleted.',
    },
    restored: {
      subject: 'Your Hook account has been restored',
      title: 'Welcome back',
      intro: 'Your deletion request was cancelled and your Hook account is active again.',
      detail: 'Nothing was removed. You can sign in to the app as usual.',
      safety: 'If you did not do this, change your password right away.',
      codeBlock: '',
      button: '',
      text: 'Your deletion request was cancelled and your Hook account is active again.',
    },
  }[payload.kind];
  return {
    subject: copy.subject,
    html: renderTemplate('account-deletion.html', baseValues({
      name: payload.name || 'there',
      title: copy.title,
      intro: copy.intro,
      detail: copy.detail,
      safety: copy.safety,
      codeBlock: copy.codeBlock,
      button: copy.button,
    })),
    text: copy.text,
  };
}
