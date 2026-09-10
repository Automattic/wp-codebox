# Native Bricks Worker telemetry

The actual native revision, restoration, protected rendering, replay, and polling passed on the normally deployed disposable Cloudflare Worker. **The memory release gate failed.** Successful HTTP responses do not override the observed isolate memory above 128 MiB.

Runtime source: `2f851aa136cb0a20a0bed1c456a6469c12767ba6`; deployed tree: `fd4775e974239de81092356223c78bb4836291db`; Worker version: `048eaf36-9226-4a86-860b-50e19cf558c6`. Only the completed `native-api` fixture was revised, from version 5 to 6 and restored as new monotonic version 7. Default canonical version 24 and the separate engine/sales allocations remained unchanged. Their version-preview deployments were not promoted or replaced.

## Actual invocation measurements

These are Cloudflare Wrangler tail CPU and wall measurements in milliseconds, not client stopwatch estimates. All ten captured invocations returned HTTP 200, outcome `ok`, no exceptions, and untruncated logs.

| Request | Worker CPU ms | Worker wall ms |
| --- | ---: | ---: |
| Default public page, cache hit | 15 | 460 |
| Restored native preview, first measured render | 5,913 | 9,619 |
| Restored native preview, repeat | 5,067 | 8,810 |
| Existing immutable artifact staging | 29 | 976 |
| Actual native revision, version 6 | 9,525 | 20,340 |
| Revised preview with changed heading | 6,859 | 10,712 |
| Restore prior native content as version 7 | 5,840 | 9,989 |
| Restored preview with original heading | 5,440 | 8,675 |
| Idempotent restore replay | 27 | 624 |
| Terminal operation poll | 3 | 129 |

The configured CPU limit is 300,000 ms. This bounded rehearsal stayed below that limit. Protected preview responses remained `private, no-store`, with exact canonical revision/receipt headers. Both expected headings were observed by the actual Build writer rehearsal. This is a native fixture qualification, not model-generated customer design acceptance or a licensed visual-editor transaction.

## Memory failure

Cloudflare GraphQL reported V8 isolate memory of **225,888,500–268,639,500 bytes** for the four native preview invocations. The corresponding WebAssembly linear memory series was **139,198,460 bytes** in every preview row. The restore invocation reported 245,154,200 bytes isolate memory and 115,998,720 bytes WASM memory. Do not add these series together or substitute the PHP allocator peak for either.

The revision's separately persisted PHP allocator peak was 52,953,088 bytes; restore's was 48,758,784 bytes. The revision's post-execution GraphQL sample was 67,408,360 bytes with zero WASM memory. These samples are not a heap-retention profile or a complete within-request peak measurement.

[Cloudflare's metric definition](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#memory-usage) describes whole-isolate memory. Its [memory-limit documentation](https://developers.cloudflare.com/workers/platform/limits/#memory) includes JavaScript and WebAssembly and allows in-flight requests to finish when an over-limit isolate is replaced. Therefore, HTTP 200 does not establish compliance. The exact GraphQL response and introspected metric descriptions are retained here. Resource acceptance remains failed pending a measured reduction; licensed Bricks editor acceptance remains unrun because no legitimate license is configured.

## Other measured counts and their scope

For `2026-09-10T20:13:00Z` through `20:18:00Z`, the shared disposable database reported 141 read queries, 10 write queries, 247 rows read, and 16 rows written. The shared bucket reported 46 GetObject and 48 PutObject operations. These are interval totals for the resources, including any operator/other-caller activity; they are not per-invocation attribution. The Worker analytics subrequest series returned zero; this does not mean there were zero D1/R2 calls.

The restored manifest inventories 147 canonical files (38,450 bytes), 1,605 wp-content entries (76,474,629 bytes, including R2-only browser assets), and one 68-byte fixture image. Its canonical restore pack is 3,051,273 compressed bytes / 13,873,644 decoded bytes over 1,021 files. Logical inventory is not physical bucket usage or live isolate memory.

## Evidence

- [Receipt and before/after state](receipt.json)
- [Sanitized exact invocation measurements](invocations.json)
- [GraphQL Worker query](analytics-query.json) and [response](analytics-response.json)
- [GraphQL D1/R2 query](bindings-query.json) and [response](bindings-response.json)
- [Actual Build revision/restore requests and receipts](mutations.json)
- [PHP revision observation](revised-php-measurements.json) and [restore observation](restored-php-measurements.json)
- [Introspected memory field descriptions](AccountWorkersInvocationsAdaptiveQuantiles.json)

The raw tail, deployment configuration, and credentials remain in the ignored private preparation directory. Only redacted invocation fields and non-secret proof inputs are exported. No customer resources were changed, and no active allocation was cleaned up.
