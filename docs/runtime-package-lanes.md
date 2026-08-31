# Runtime Package Lanes

The root package is the Node CLI lane. Its explicit workspace list excludes Cloudflare, so a default root `npm ci`, `npm run build`, `npm run check`, or `npm pack` does not install, compile, test, or package Cloudflare. The root's `cloudflare:*` commands only forward into the package with `npm --prefix packages/runtime-cloudflare run ...`.

`packages/runtime-cloudflare` remains in the monorepo but has its own packed `npm-shrinkwrap.json`, runtime and development dependencies, install-time stream-compression patch, TypeScript check, tests, Wrangler dry runs, package dry run, generators, and local gates. Its operational commands resolve only package-owned scripts, assets, dependencies, and configs, and local gates provision their locked Playwright Chromium before use. The packed artifact bundles the selected contract surface and dependency closure reproducibly compiled from the immutable `@automattic/wp-codebox-core` `0.26.2` release tag. Root boundary tests compare every generated JavaScript and declaration byte and cover positive and negative contract behavior. Install it reproducibly with:

```sh
npm ci --prefix packages/runtime-cloudflare --workspaces=false
```

Run both independent lanes with `npm run check:all`.
