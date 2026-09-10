# Native Bricks media rendering on Cloudflare

The unmodified `packages/runtime-cloudflare/scripts/bricks-render-proof.mjs` passes against the normal canary root on desktop (1440px) and mobile (390px). Both render 42 native elements, four sections, and four loaded images with no horizontal overflow. Both screenshots were visually inspected.

Commit `4f09dc8a` restores integrity-checked upload hydration, including revisions reconstructed from restore packs. Bricks checks actual file existence/readability/size; WordPress media operations and the mutation inventory also require those files. Browser image requests still stream R2 assets. A sampled original JPEG returned HTTP 200, `image/jpeg`, and `x-wp-codebox-static: r2-upload`. No health-filter override or placeholder file was used.

Commit `0abe2512` advances the runtime page-cache namespace and applies it to both edge keys and persisted R2 render-cache keys. This prevents the unchanged canonical revision from serving the previous imageless render after a runtime upgrade. Explicit published artifacts and canonical state retain their original keys.

Deployment: `a1e7ea0c-119f-490d-8112-f03aad1a050c`. The fresh desktop response reports `miss` / `render`; mobile reports `hit` / `edge`. The receipt records screenshot hashes, selected response headers, and test outcomes.

This is native public-render evidence, not licensed-editor or customer-operability acceptance. The existing navy project section has dark body copy with poor contrast; it remains a native design correction. No authenticated native edit was available in this bounded repair, and no arbitrary canonical metadata change was made. The fixture's approximately 4.1 MB upload set passed; larger media inventories need separate memory qualification.
