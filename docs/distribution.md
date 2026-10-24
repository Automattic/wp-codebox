# Distribution

## Release Assets

Every GitHub Release attaches three artifacts built from the same commit:

| Asset | What it is |
| --- | --- |
| `wp-codebox-cli-<platform>-<arch>.tar.gz` | Self-contained CLI: compiled packages, production dependencies, a pinned Node.js runtime under `vendor/node`, and a `bin/wp-codebox` launcher. Built by `npm run release:package`. |
| `wp-codebox-workspace-<version>.tgz` | The root workspace package. Installing it globally exposes the `wp-codebox` binary from `packages/cli/dist/index.js` on your own Node.js. |
| `wp-codebox.zip` | The WordPress plugin (`packages/wordpress-plugin`), with the vendored CLI runtime. Built by `npm run package:wordpress-plugin`. |

The scoped npm packages (`@automattic/wp-codebox-core`, `-playground`, `-cli`)
are prepared in the workspace but not published to the npm registry. Install
from a release asset or a checkout.

## Installing The CLI

Self-contained tarball, no Node.js required on the host:

```bash
curl -L -o wp-codebox.tar.gz https://github.com/Automattic/wp-codebox/releases/latest/download/wp-codebox-cli-linux-x64.tar.gz
tar -xzf wp-codebox.tar.gz
./wp-codebox-cli/bin/wp-codebox commands --json
```

The launcher prefers the bundled `vendor/node/bin/node`, then `node` or
`nodejs` on `PATH`; set `WP_CODEBOX_NODE_BIN` to choose one explicitly.

Workspace tarball on an existing Node.js:

```bash
npm install -g https://github.com/Automattic/wp-codebox/releases/download/v<VERSION>/wp-codebox-workspace-<VERSION>.tgz
wp-codebox commands --json
```

From a checkout:

```bash
npm install
npm run build
npm run wp-codebox -- commands --json
```

## Installing The WordPress Plugin

Install `wp-codebox.zip` on the parent site, then tell it where the CLI is. The
runner resolves the binary from ability input first, then the `wp_codebox_bin`
option, then the `wp_codebox_bin` filter. Multisite installs read the option
from network options, because the executable path is host-level configuration.

- **Self-hosted control planes:** install the CLI on the host that runs PHP and
  point `wp_codebox_bin` at it. Supply runtime components through the
  `wp_codebox_component_contracts` option or filter.
- **Local development:** point `wp_codebox_bin` at `bin/wp-codebox-source.mjs` in
  a checkout. It runs the incremental source build before every invocation, so
  ignored `dist/` output never predates the checked-out source.
- **Hosted control planes:** deploy the CLI and plugin zip from the same release,
  configure the binary and component contracts centrally, and expose only the
  parent-site abilities to products.

## Releases

Releases are continuous. Every push to `main` runs the release workflow
(`.github/workflows/release.yml`), which derives the version from conventional
commits since the last tag (`fix:` is a patch, `feat:` a minor, a breaking change
a major; `chore:`, `ci:`, `docs:`, and `test:` do not release), runs the quality
gates, tags, writes `CHANGELOG.md`, and publishes the GitHub Release with its
assets. Run the workflow manually with `dry-run` to preview the next version.

The workspace packages and the plugin share one version: keep
`packages/wordpress-plugin/wp-codebox.php` `Version:` aligned with
`package.json`.

`npm run smoke -- --group package` validates the artifact shapes: the CLI pack
contains compiled `dist/` without TypeScript source, the root tarball installs a
working `wp-codebox` binary that can emit the command catalog, and the plugin zip
contains the bootstrap, PHP sources, browser runtime asset, and vendored CLI
without package metadata or generated artifacts.
