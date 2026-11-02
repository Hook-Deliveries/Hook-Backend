import fs from 'fs';
import path from 'path';
import {
  setResolvedEmailSettings,
  otpEmailTemplate,
  passwordResetEmailTemplate,
  welcomeEmailTemplate,
  waitlistMessageEmailTemplate,
  broadcastMessageEmailTemplate,
  accountInvitationEmailTemplate,
  customerAccountSetupEmailTemplate,
  orderConfirmationEmailTemplate,
  vendorNewOrderEmailTemplate,
  hookNewOrderEmailTemplate,
  orderAwaitingPaymentEmailTemplate,
  orderStatusUpdateEmailTemplate,
  vendorApprovedEmailTemplate,
  vendorRejectedEmailTemplate,
  settlementUpdateEmailTemplate,
  orderCancelledEmailTemplate,
  paymentConfirmedEmailTemplate,
  refundIssuedEmailTemplate,
  negotiationOfferEmailTemplate,
  negotiationAcceptedEmailTemplate,
  submissionDecisionEmailTemplate,
  accountActivatedEmailTemplate,
  availabilityDigestEmailTemplate,
  accountDeletionEmailTemplate,
} from '../../emails/templates';

setResolvedEmailSettings({ appName: 'Hook', appUrl: 'https://hook.africa', supportEmail: 'support@hook.africa' });

const order = {
  to: 'ada@example.com',
  name: 'Ada',
  orderCode: 'ORD-9F31Z',
  amount: 450000,
  itemCount: 2,
  customerName: 'Ada Obi',
  vendorName: 'Balogun Market Stall 12',
  status: 'confirmed',
  detail: 'Your order has been confirmed and is being prepared.',
  dashboardUrl: 'https://hook.africa/orders/ORD-9F31Z',
  lines: [
    { title: 'Fresh tomatoes', quantity: 2, amount: 300000 },
    { title: 'Yam tubers', quantity: 1, amount: 150000 },
  ],
  subtotal: 450000,
  deliveryFee: 150000,
  discount: 0,
  deliveryAddress: '12 Allen Avenue, Ikeja, Lagos',
  expectedDeliveryDate: '2026-09-30',
};

const previews: Record<string, { subject: string; html: string; text?: string }> = {
  'otp': otpEmailTemplate({ email: 'ada@example.com', code: '482913', name: 'Ada', expiresInMinutes: 10 }),
  'password-reset': passwordResetEmailTemplate({ email: 'ada@example.com', code: '731502', name: 'Ada', expiresInMinutes: 10 }),
  'welcome': welcomeEmailTemplate({ email: 'ada@example.com', name: 'Ada' }),
  'waitlist-message': waitlistMessageEmailTemplate({ email: 'ada@example.com', name: 'Ada', subject: "We're launching soon!", message: 'Hook is almost ready. Thanks for waiting.', unsubscribeUrl: 'https://hook.africa/unsubscribe/abc' }),
  'broadcast-message': broadcastMessageEmailTemplate({ email: 'ada@example.com', name: 'Ada', subject: 'New feature: Hook credit', message: 'You can now earn Hook credit on every order.' }),
  'account-invitation': accountInvitationEmailTemplate({ email: 'ada@example.com', name: 'Ada', accountType: 'staff', activationUrl: 'https://hook.africa/activate/abc', expiresInHours: 48 }),
  'customer-account-setup': customerAccountSetupEmailTemplate({ email: 'ada@example.com', name: 'Ada', partnerName: 'Balogun Market Partner', activationUrl: 'https://hook.africa/activate/abc', expiresInHours: 48 }),
  'order-confirmation': orderConfirmationEmailTemplate(order),
  'vendor-new-order': vendorNewOrderEmailTemplate(order),
  'hook-new-order': hookNewOrderEmailTemplate(order),
  'order-awaiting-payment': orderAwaitingPaymentEmailTemplate({ ...order, paymentUrl: 'https://hook.africa/pay/abc' }),
  'order-status-update': orderStatusUpdateEmailTemplate(order),
  'vendor-approved': vendorApprovedEmailTemplate({ to: 'vendor@example.com', vendorName: 'Balogun Market Stall 12' }),
  'vendor-rejected': vendorRejectedEmailTemplate({ to: 'vendor@example.com', vendorName: 'Balogun Market Stall 12', reason: 'Incomplete documentation' }),
  'settlement-update': settlementUpdateEmailTemplate(order),
  'order-cancelled': orderCancelledEmailTemplate({ to: 'ada@example.com', name: 'Ada', orderCode: 'ORD-9F31Z', amount: 450000, reason: 'Cancelled by customer' }),
  'payment-confirmed': paymentConfirmedEmailTemplate({ to: 'ada@example.com', name: 'Ada', orderCode: 'ORD-9F31Z', amount: 450000 }),
  'refund-issued': refundIssuedEmailTemplate({ to: 'ada@example.com', name: 'Ada', orderCode: 'ORD-9F31Z', amountMinor: 450000, fullyRefunded: true }),
  'negotiation-offer': negotiationOfferEmailTemplate({ to: 'ada@example.com', name: 'Ada', productTitle: 'Fresh tomatoes (5kg)', counterPriceMinor: 250000, expiresAt: new Date(Date.now() + 3600_000) }),
  'negotiation-accepted': negotiationAcceptedEmailTemplate({ to: 'ada@example.com', name: 'Ada', productTitle: 'Fresh tomatoes (5kg)', agreedPriceMinor: 250000, quoteExpiresAt: new Date(Date.now() + 3600_000) }),
  'submission-decision': submissionDecisionEmailTemplate({ to: 'vendor@example.com', name: 'Vendor', productTitle: 'Fresh tomatoes (5kg)', decision: 'approved' }),
  'account-activated': accountActivatedEmailTemplate({ email: 'ada@example.com', name: 'Ada', accountType: 'customer' }),
  'availability-digest': availabilityDigestEmailTemplate({ to: 'ma@example.com', name: 'Chidi', products: [{ title: 'Fresh tomatoes', marketName: 'Balogun Market' }, { title: 'Yam tubers', marketName: 'Mile 12 Market' }] }),
  'account-deletion': accountDeletionEmailTemplate({ email: 'ada@example.com', kind: 'scheduled', name: 'Ada', scheduledFor: '30 October 2026', cancelUrl: 'https://hook.africa/cancel-deletion/abc' }),
};

const outDir = path.join(__dirname, '..', '..', '..', '..', 'Hook-Admin', 'public', 'email-previews');
fs.mkdirSync(outDir, { recursive: true });

const index: string[] = [];
for (const [key, result] of Object.entries(previews)) {
  fs.writeFileSync(path.join(outDir, `${key}.html`), result.html);
  index.push(`<li><a href="/email-previews/${key}.html" target="preview">${key}</a> — <span style="color:#888">${result.subject}</span></li>`);
}
fs.writeFileSync(
  path.join(outDir, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>Email previews</title><style>body{font-family:system-ui;margin:0;display:flex;height:100vh;background:#fff;color:#18181b}nav{width:300px;overflow:auto;padding:16px;border-right:1px solid #ddd}nav ul{list-style:none;padding:0;margin:0}nav li{padding:6px 0}nav a{text-decoration:none;color:#18181b;font-weight:600}iframe{flex:1;border:0}</style></head><body><nav><h3>${Object.keys(previews).length} templates</h3><ul>${index.join('')}</ul></nav><iframe name="preview" src="/email-previews/${Object.keys(previews)[0]}.html"></iframe></body></html>`,
);

console.log(`Wrote ${Object.keys(previews).length} template previews + index.html to ${outDir}`);
