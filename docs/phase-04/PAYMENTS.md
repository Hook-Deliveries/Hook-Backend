# Payments

`PaymentProvider` isolates provider behavior. Paystack Hosted Checkout is the only active prepayment provider. Initialization accepts an owned Order public ID; amount, currency, customer, reference, and metadata come from the Order.

The raw-body webhook validates `x-paystack-signature`, deduplicates provider events, re-queries Paystack, and checks reference, amount, currency, and success status. Shopper deep links trigger polling only and never confirm payment.

## Paystack dashboard configuration

Configure the Paystack test-mode dashboard with these HTTPS endpoints:

- Callback URL: `https://hook-api.onrender.com/api/v1/payments/paystack/callback`
- Webhook URL: `https://hook-api.onrender.com/api/v1/webhooks/paystack`

The callback is a browser-return bridge only. It validates the reference format, redirects to `hook://payments/return`, and causes the Shopper App to poll Hook's payment-status endpoint. It cannot mark a payment successful.

The webhook is the payment-evidence boundary. Hook validates Paystack's HMAC signature against the untouched raw request body, deduplicates events, re-queries the provider, and verifies the reference, amount, currency, and provider status before confirming payment or advancing an Order.

The deployed backend must configure `PAYSTACK_SECRET_KEY`, `PAYSTACK_CALLBACK_URL`, and `PAYSTACK_APP_RETURN_URL`. Localhost cannot receive Paystack webhooks; test deliveries require the deployed HTTPS API or a trusted HTTPS tunnel.
