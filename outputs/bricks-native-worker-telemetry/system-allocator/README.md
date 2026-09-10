# Native system-allocator follow-up

Source `0bd5103e`, normal disposable Worker version `7657aa45-c5f2-4ac5-ab0c-783544bc3452`. The native PHP startup uses `USE_ZEND_ALLOC=0`; the default WordPress runtime keeps its original allocator. No vendor ZIP or WASM binary changed. Package build and 14 focused native API/artifact/preview tests passed.

The actual Build writer repeated a native revision and restore, rendered both expected headings, verified replay and terminal polling, and restored the previous content as **new canonical version 9**. All ten captured invocations returned HTTP 200, outcome `ok`, and no exceptions. Default canonical version 24 and the engine/sales allocations remained unchanged. The public default page still returned 200. Active version-preview aliases were not upgraded.

| Request | Worker CPU ms | Worker wall ms |
| --- | ---: | ---: |
| Protected preview, first render | 3,307 | 6,337 |
| Protected preview, repeat | 3,037 | 4,918 |
| Immutable artifact staging | 6 | 202 |
| Actual native revision, version 8 | 4,458 | 12,921 |
| Revised protected preview | 3,065 | 5,478 |
| Restore native content as version 9 | 3,118 | 6,269 |
| Restored protected preview | 3,134 | 5,622 |
| Restore replay | 5 | 157 |
| Operation poll | 2 | 104 |
| Default public cache hit | 10 | 375 |

**Memory qualification still fails.** The four rendered previews report 184,273,280–192,740,510 bytes of V8 isolate memory, including 80,543,740 bytes of WebAssembly linear memory. The original allocator's corresponding preview ranges were 225,888,500–268,639,500 bytes total and 139,198,460 bytes WASM. This is a measured improvement, not compliance with the 134,217,728-byte limit. GraphQL may group multiple invocations into a timestamp row; exact per-request CPU/wall comes from the retained tail events. Its samples are not a full execution-peak or retained-object profile.

The PHP resource receipts now explicitly identify the system allocator and record `peak_php_bytes: null`. PHP's internal counter is unavailable in this mode. Remote Worker CPU, wall, and memory are preserved separately rather than being attributed to those PHP receipts retroactively.

The query interval's shared-resource totals are 100 D1 read queries, 12 write queries, 270 rows read, 18 rows written, 35 R2 GetObject operations and 39 PutObject operations. They include operator/other-caller activity and are not exact attribution to a single request. The GraphQL subrequest series returned zero; the positive binding counts must not be replaced by that field. The exported query contains the exact observation window.

- [Receipt and exact before/after pointers](receipt.json)
- [Actual Build requests, operation receipts, and observations](mutations.json)
- [Ten sanitized invocation events](invocations.json)
- [GraphQL memory/CPU response](analytics-response.json) and [query](analytics-query.json)
- [Shared D1/R2 response](bindings-response.json) and [query](bindings-query.json)
- [Revision PHP observation](revised-php-measurements.json) and [restore PHP observation](restored-php-measurements.json)

All local profiler and tail processes were stopped. Further memory reduction and the licensed visual-editor transaction remain outstanding. This native fixture rehearsal is not proof of a generated customer site or production readiness.
