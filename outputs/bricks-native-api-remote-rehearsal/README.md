# Remote native Bricks API fixture rehearsal

The real Build artifact producer and writer drove the existing isolated Cloudflare Worker, D1 and R2 through native provision, revision, stale-base rejection, restore, idempotent replay, operation polling and authenticated preview observation. This is a fixture API proof, not an AI-generated customer site or licensed editor acceptance.

- Native source: `2f851aa1` on `codex/bricks-cloudflare-native`.
- Namespace: `native-api`, isolated from the original default canary and customer resources.
- Canonical versions: provision 3, revise 4, restore 5. Restore creates a new revision with the original native content hashes.
- Final preview Worker version: `5e5b9b92-3593-494b-83be-9fda4b7348cc`.
- A fresh Worker version reconstructed the restored content from D1/R2 and rendered desktop and mobile: 19 native elements, two loaded fixture images, no horizontal overflow. Screenshots were inspected.
- Unauthorized preview returns 401, stale preview 409, preview POST 405, and the raw native hostname 404. All use private/no-store responses.
- The original provision receipt remains an immutable historical draft. Later revision and restore receipts advertise the authenticated protected preview. No receipt claims accepted/published or verified client editing.

The failures during remote qualification were resolved by preparing a verified restore pack outside Worker requests, preserving the immutable runtime package during native mutations, releasing PHP before packing changed canonical state, and disabling OPCache file caching for reconstructed native runtimes. The final source retains normal PHP rendering; no custom HTML substitute, stdout workaround, warning-assisted editor route or license bypass is used.

`receipt.json` contains exact native operation receipts, source/artifact hashes, actual PHP peak memory and wall observations, access checks, state pointers and the original normal deployment check. Preview aliases do not expose Worker logs, so CPU, resident isolate peak and detailed operation counts remain unmeasured here. The final artifact producer provenance is retained separately from runtime source identity.

The fixture intentionally uses placeholder pixel media and no bundled fonts. Its sparse screenshots demonstrate native rendering and reconstruction mechanics; they are not customer design evidence. A legitimate agency-owned Bricks license is still absent, so the real visual editor and Editor-role edit/publish/observe/restore/reopen transaction remain unqualified.

The separate `native-engine` allocation was handed to the parent and BUILD/T for the actual generated-site product flow using final Worker preview version `a4c5d612-4d6a-4599-ad19-3bd7d80b45b3`. It was empty at handoff. Existing customer static preview and public default canonical state were not changed by this rehearsal.

Validation: package TypeScript build, 144 runtime tests, two package boundary tests, and all 14 focused native/preview tests pass. The full package command was attempted; its canonical MDI seed-regeneration test cannot run because the host has no `php` executable. The 144-test run excludes that single host-PHP check. Actual local PHP-WASM and remote Worker rehearsals ran successfully. Desktop and mobile screenshots are byte-identical before and after the final Worker version upload.
