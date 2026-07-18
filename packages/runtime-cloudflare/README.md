# Cloudflare Runtime Gate

This additive integration is the first acceptance gate for [wp-codebox#1838](https://github.com/Automattic/wp-codebox/issues/1838). It compiles the current PHP 8.5 Asyncify Wasm asset for workerd, boots WordPress through Playground with the current SQLite integration release, executes PHP, and returns a Codebox runtime-command-result envelope containing the stable `wp-codebox/cloudflare-runtime-health/v1` health payload.

The Worker owns Cloudflare transport and isolate lifecycle. This gate uses one Playground PHP instance per isolate; Durable Objects will serialize site mutation in a later gate. The response identifies the generic `wordpress-playground` backend and `wordpress` environment; callers do not receive Cloudflare binding or limit details. Runtime snapshots, restore, R2, serialization, and cold restoration are deferred to later gates.

## Verification

1. Install dependencies with `npm ci`.
2. Run `npm run build`; expect the existing Codebox packages to compile.
3. Run `npm run test:cloudflare-runtime`; expect the deterministic health response to contain the Codebox command-result schema and boot/execution evidence.
4. Run `npm run cloudflare:dry-run`; expect Wrangler to compile the Worker and report the Worker bundle size. This creates no Cloudflare resources.
5. Run `npm run cloudflare:local-gate`; expect two HTTP 200 health envelopes from local workerd and automatic server cleanup. This validates packaging and the real Worker boot path.
6. After configuring a Cloudflare account and an explicit deployment target, run `npm exec -- wrangler deploy --config packages/runtime-cloudflare/wrangler.jsonc`; request the deployed URL and expect `marker: "wp-codebox-cloudflare-runtime-health"`, WordPress and PHP versions, and completed initialization/execution evidence.
7. Remove the deployed Worker with `npm exec -- wrangler delete --config packages/runtime-cloudflare/wrangler.jsonc` when the remote gate is no longer needed.

The remote request in step 6 is the memory and boot acceptance gate. Cloudflare Workers enforces the 128 MB isolate limit remotely; a local workerd result does not establish that limit.
