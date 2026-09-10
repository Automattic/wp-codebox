# Native Bricks API local rehearsal

Actual Build producer and writer at `db6717f419bfd848296db4eb193b77ff91db4e0a` called the local Cloudflare Worker, D1 and R2 emulator. The Worker ran PHP-WASM 8.5 and the original agency-provided Bricks 2.4-rc ZIP, SHA-256 `a97171e889ff82a92949dff994f10ceeb38cc70d46d7df3d97d3522562c2e887`. Every Bricks vendor file in this allocation was extracted directly from that ZIP. The SQLite alias correction is a separate checked-in runtime materialization patch.

The source allocation started with no native documents or uploads. Provision committed revision 2, revision committed 3, a stale base returned HTTP 409, and restore committed NEW revision 4 with the original native document hashes and design-system version. Each operation passed the real Build writer terminal-receipt validator, byte-equivalent idempotent replay, operation polling, and public heading observation. `receipt.json` contains the exact requests and receipts. `artifact.json` is the staged original native artifact.

After stopping and restarting Wrangler, `cold-reopen.json` confirms the saved operation receipt, restored native heading, loaded images, and desktop/mobile rendering. Screenshots were inspected. This is a deliberately minimal API fixture with two one-pixel image instances, not a customer design or a visual parity acceptance result. The authored font-family CSS is present; the fixture does not bundle the requested webfont binaries.

All native receipts remain `draft`, with null protected preview, false editor qualification, and all five client-acceptance steps `not_run`. No Bricks license activation or actual visual-editor acceptance occurred. Programmatic native save and rollback proof does not replace the licensed editor transaction.

Validation: package TypeScript build, seven focused artifact/admission tests, actual local PHP integration, and existing canary Wrangler deployment dry run passed. No remote deployment or customer site mutation was performed for this local API proof.
