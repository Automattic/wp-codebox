# Cookbook recipes

Recipes that exercise realistic surface area, intended as starting points for
adopters whose first non-toy attempt to use WP Codebox is "test my plugin
against bbPress" or "drive my theme against seeded content."

These are not internal correctness fixtures (the recipes in
`examples/recipes/*.json` cover that). They are product fixtures: each one
mounts a target plugin or theme, seeds a realistic host context via Playground
blueprint steps, and is intended to be paired with `--preview-hold` for visual
smoke testing.

## Available recipes

### `multisite-network.json`

Converts the Playground install to multisite with WP-CLI, mounts your plugin
under test, network-activates it when a plugin file is present, seeds two child
sites through a WP-CLI `eval-file` seed, and emits network, site, and admin URLs
from the seed step.

**Replace** the `inputs.mounts[0].source` value in the recipe with the path to
the plugin you want to exercise in network mode. The default points at
`../simple-plugin` so the recipe runs out of the box.

```bash
# Edit examples/recipes/cookbook/multisite-network.json:
#   "source": "../../path/to/your-plugin"
#
# Then:
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/multisite-network.json \
  --preview-hold 30m \
  --json
```

The seed step's JSON output includes `network_admin_url`, `main_site_url`, and a
`sites` array with two child-site URLs and admin URLs. Pair with
`--preview-hold` to click through network admin and child-site screens while the
Playground preview stays alive.

#### Why this exists

Many WordPress plugins only break when they are network-active, read network
options, or run across multiple sites. This recipe gives plugin authors a
repeatable first smoke test for that surface without requiring a local multisite
install.

#### Extending

The seed step is intentionally small. Add more sites, roles, options, or content
in `multisite-network-seed.php` before the JSON output line if your plugin needs
a richer network shape.

### `bbpress-reply-editor.json`

Boots a Playground with bbPress installed from `wordpress.org/plugins`, mounts
your plugin under test, seeds one forum and one topic, and auto-logs in as
admin. Pair with `--preview-hold` and navigate the preview URL from the seed
output to land on the bbPress reply form.

**Replace** the `inputs.mounts[0].source` value in the recipe with the path
to the plugin you want to exercise against bbPress. The default points at
`../simple-plugin` so the recipe runs out of the box, but the interesting
mount target is whatever editor-or-reply-handling plugin you're debugging.

```bash
# Edit examples/recipes/cookbook/bbpress-reply-editor.json:
#   "source": "../../path/to/your-plugin"
#
# Then:
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/bbpress-reply-editor.json \
  --preview-hold 30m \
  --json
```

The seed step's JSON output includes the preview URLs for the seeded reply
form.

#### Why this exists

The motivating use case was debugging a runtime regression in
[Extra-Chill/blocks-everywhere](https://github.com/Extra-Chill/blocks-everywhere)
after a major refactor (removing the bundled isolated-block-editor dependency).
Two production deploys to extrachill.com broke the bbPress reply editor because
the change had never been runtime-tested against a real bbPress host page. A
sandbox recipe that boots bbPress + the plugin under test + a seeded topic is
exactly the smoke-test surface that would have caught the regression before
release.

This recipe is the generalized version of that smoke test. Drop in any plugin
that hooks the bbPress reply editor surface and the preview URL gives you a
real reply form to click into.

#### Extending

The seed step is intentionally small. If you need additional bbPress shape
(multiple forums, nested replies, custom user roles, additional topics with
varying content shapes), edit `bbpress-reply-editor-seed.php` to add them
before the JSON output line, or fork the recipe entirely.
