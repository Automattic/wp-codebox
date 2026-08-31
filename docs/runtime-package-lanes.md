# Runtime Package Lanes

The root package is the Node CLI lane. Its explicit workspace list excludes Cloudflare, so a default root `npm ci`, `npm run build`, `npm run check`, or `npm pack` does not install, compile, test, or package Cloudflare. The root's `cloudflare:*` commands only forward into the package with `npm --prefix packages/runtime-cloudflare run ...`.

`packages/runtime-cloudflare` remains in the monorepo but has its own `package-lock.json`, runtime and development dependencies, install-time stream-compression patch, TypeScript check, tests, Wrangler dry runs, package dry run, and local gates. Its build checks only the Cloudflare package; it never builds or packages the Playground or CLI. Install it reproducibly with:

```sh
npm ci --prefix packages/runtime-cloudflare --workspaces=false
```

Run both independent lanes with `npm run check:all`.
