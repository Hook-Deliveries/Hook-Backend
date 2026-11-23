# Hook Storefront 503 Incident Report

**Incident date:** 22–23 November 2026 (UTC)

**Status:** Mitigated in production

**Classification:** Nginx request rejection; no API process crash observed

## Summary

The storefront generated bursts of parallel catalog requests. Nginx allowed only 20 simultaneous requests per client IP and returned its default `503` status when that connection limit was reached. The requests that triggered the failures were rejected at the proxy and did not reach the API handlers.

The Gmail alert was the Grafana `hook-5xx` rule, which fires after more than 20 HTTP 5xx responses in five minutes. Some corresponding “resolved” messages used the rule's `NoData`-as-OK behavior and did not, by themselves, confirm recovery.

## Impact and evidence

- A sampled eight-hour Nginx log window contained 506 HTTP 503 responses and 506 matching `limiting connections by zone "perip"` errors.
- A later rolling ten-minute window showed 96 matching 503 responses and connection-limit errors.
- Requests came from the production storefront and included many individual product-detail requests, along with categories, markets, and banners.
- API containers remained healthy. The health endpoint and a public-products request returned HTTP 200 during verification.
- The separate Nginx request-rate limit (`30r/s`, burst `60`) was configured to return 429 and did not produce rejects in the latest pre-deployment ten-minute sample.
- The exact start of the incident and the number of affected shoppers or transactions were not established from the retained logs.

## Root cause

The production Nginx configuration applied `limit_conn perip 20` across the API server. Nginx's default status for a connection-limit rejection is 503 because no explicit `limit_conn_status` was configured. Catalog requests arriving concurrently from the same client IP exceeded that cap, so Nginx rejected them and the 5xx alert fired.

This was not an API process crash or a failure in the product handlers. The request pattern indicates that the storefront's parallel catalog fetches contributed to the bursts.

## Resolution

Production Nginx configuration was changed to:

```nginx
limit_conn perip 100;
limit_conn_status 429;
```

The existing request-rate limit remains in place. If the higher concurrency cap is exceeded in the future, Nginx now identifies that rejection as HTTP 429 rather than a server error.

The change was committed as [`57ac432`](https://github.com/Hook-Deliveries/Hook-Backend/commit/57ac4323988c3a50020c88ac82241ec88401c112). CI and the production deployment both succeeded.

## Verification

After deployment:

- Nginx reported the loaded `limit_conn perip 100` and `limit_conn_status 429` directives.
- All three API containers were healthy.
- `/health` and `/api/v1/public/products?limit=1` returned HTTP 200.
- From 01:42:30 to 01:44:01 UTC, Nginx logged zero 503 responses and zero per-IP connection-limit rejections.

This was a passive observation window; no synthetic high-concurrency load test was run.

## Follow-up

1. Review the storefront's catalog loading so product-list pages avoid unnecessary parallel product-detail requests.
2. Review the Grafana rule's `noDataState: OK` behavior. It can produce resolved notifications when the query returns no data, which is distinct from recovery.
3. Monitor HTTP 429 counts after the new concurrency cap. Large bursts can still be throttled by the concurrency or existing request-rate limit.
