# Cloudflare provisioning API core

The D1 Worker exposes a versioned control-plane API before hostname-based WordPress routing. `/v1/*` never boots or falls through to WordPress.

## Authentication

`WORDPRESS_API_TOKENS` is a JSON array of bounded verifier records:

```json
[{"id":"client-a","principal":"client-a","digest":"<sha256 bearer token hex>","scopes":["sites:create","sites:read","sites:import","operations:read"],"expiresAt":"2027-01-01T00:00:00.000Z","maxSites":3,"sites":["optional-existing-site"]}]
```

The Worker compares SHA-256 token digests and never accepts plaintext API credentials in configuration. `WORDPRESS_OPERATOR_TOKEN` remains exclusive to legacy `?phase=operator-*` endpoints.

## Resources

- `POST /v1/sites` requires `Authorization: Bearer ...` with `sites:create` and `Idempotency-Key`. Its body is `wp-codebox/provisioning-create-request/v1`; it references an immutable staged artifact at `sites/provisioning/import-artifacts/<sha256>.json`. The Worker verifies the bounded artifact before allocating a site, then copies it immutably to the selected site namespace.
- `GET /v1/sites/{siteId}` requires `sites:read`.
- `POST /v1/sites/{siteId}/imports` requires `sites:import` and uses the existing bounded static-artifact request.
- `GET /v1/sites/{siteId}/operations/{operationId}` requires `operations:read`.

All responses use versioned WP Codebox provisioning schemas. Site IDs are allocated only from `WORDPRESS_SITE_CONTEXTS`; caller hostnames, DNS, and Cloudflare control APIs are not inputs. The allocation transaction reserves the same shipped D1 site identity used by legacy/operator operations, so both interfaces contend on one hostname and an existing site cannot be taken over. D1 stores allocation ownership, immutable artifact identity and import options, and API operation links. The scheduler resumes incomplete allocations for its selected site before it runs an operation; it verifies staged bytes and converges the conditional destination copy, operation, and API link without blocking publication or cron when recovery fails.

This is the API core portion of #1971. Administrator claims are intentionally a follow-up and are not represented by a route, secret, D1 field, resource field, documentation contract, or test in this PR.
