# Cloudflare provisioning API

The D1 Worker exposes a versioned control-plane API before hostname-based WordPress routing. `/v1/*` never boots or falls through to WordPress.

## Authentication

`WORDPRESS_API_TOKENS` is a JSON array of bounded verifier records:

```json
[{"id":"client-a","principal":"client-a","digest":"<sha256 bearer token hex>","scopes":["sites:create","sites:read","sites:import","operations:read"],"expiresAt":"2027-01-01T00:00:00.000Z","maxSites":3,"sites":["optional-existing-site"]}]
```

The Worker compares SHA-256 token digests and never accepts plaintext API credentials in configuration. `WORDPRESS_OPERATOR_TOKEN` remains exclusive to legacy `?phase=operator-*` endpoints.

## Resources

- `PUT /v1/artifacts/{sha256}` requires `Authorization: Bearer ...` with `sites:create`. Its body is the canonical `blocks-engine/php-transformer/site-artifact/v1` JSON artifact. The Worker enforces the artifact byte, file, path, encoding, and digest bounds before an immutable conditional write, then returns the exact reference accepted by site creation. Replays of identical bytes converge; conflicting content at the digest-addressed key fails closed.
- `POST /v1/sites` requires `Authorization: Bearer ...` with `sites:create` and `Idempotency-Key`. Its body is `wp-codebox/provisioning-create-request/v1`; it references an immutable staged artifact at `sites/provisioning/import-artifacts/<sha256>.json`. The Worker verifies the bounded artifact before allocating a site, then copies it immutably to the selected site namespace.
- `GET /v1/sites/{siteId}` requires `sites:read`.
- `POST /v1/sites/{siteId}/imports` requires `sites:import` and uses the existing bounded static-artifact request.
- `GET /v1/sites/{siteId}/operations/{operationId}` requires `operations:read`.
- `POST /v1/sites/{siteId}/administrator-claim` exchanges its one-time bearer capability for the persistent site-scoped `admin` credential after provisioning succeeds. It does not accept an API bearer token.

All responses use versioned WP Codebox provisioning schemas. With `WORDPRESS_PREVIEW_DOMAIN` and the secret `WORDPRESS_PREVIEW_HOST_SECRET` configured, `POST /v1/sites` allocates a collision-resistant signed site ID and returns the canonical `https://{siteId}.{preview-domain}` origin. Configure the suffix as a Worker wildcard route before serving those origins; no per-site Worker configuration is needed. The Worker validates that wildcard hostname and derives the site ID before any D1, coordinator, PHP, or SQLite work; anonymous published reads therefore remain R2/cache-only. D1 transactionally stores allocation ownership, lifecycle timestamps, the canonical hostname, immutable artifact identity, import options, and API operation links. `wp_codebox_site_aliases` is reserved for custom-domain aliases and is never consulted by wildcard routing. Without a preview domain, the legacy finite `WORDPRESS_SITE_CONTEXTS` allocator remains available for existing configured deployments.

`POST /v1/sites` validates `WORDPRESS_ADMIN_CLAIM_SECRET` and `WORDPRESS_ADMIN_PASSWORD` before allocation. Its create/replay response includes the deterministic pending capability while the configured root still derives the stored digest. Site reads expose only claim state, expiry, and the fixed endpoint. D1 stores capability and derived-credential digests, never either plaintext value. Scheduled allocation recovery issues a missing claim before provisioning work can run. Redemption requires the current site-scoped credential to match the digest pinned before bootstrap, then atomically consumes the capability exactly once and transfers that persistent administrator credential; it is not a one-time browser session. Rotating either root preserves the pending record but requires restoring the matching root before replay or redemption.
