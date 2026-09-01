import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editorPresentationContractPhpCode, parseEditorPresentationContract } from "../packages/runtime-playground/src/editor-command-runners.js"
import { runCommandText } from "../scripts/test-kit.js"

const inlineIdentity = "A".repeat(64)
const externalIdentity = "b".repeat(64)
const unrelatedIdentity = "c".repeat(64)

async function captureContract(inlineCss: string[], editorVersions: unknown[], prequeuedVersions: unknown[] = []): Promise<{ identities: string[]; complete: boolean }> {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-editor-presentation-"))
  const includes = join(root, "wp-admin", "includes")
  await mkdir(includes, { recursive: true })
  await writeFile(join(includes, "class-wp-screen.php"), "<?php class WP_Screen { public static function get( $screen ) { return new self(); } public function set_current_screen() {} }\n")
  await writeFile(join(includes, "screen.php"), "<?php function set_current_screen( $screen ) { WP_Screen::get( $screen )->set_current_screen(); }\n")
  const php = `
define( 'ABSPATH', ${JSON.stringify(`${root}/`)} );
class WP_Post {}
class WP_Block_Editor_Context { public function __construct( public array $context ) {} }
$fixture_inline_css = ${JSON.stringify(inlineCss)};
$fixture_editor_versions = ${JSON.stringify(editorVersions)};
$fixture_prequeued_versions = ${JSON.stringify(prequeuedVersions)};
$fixture_styles = new class {
  public array $queue = array();
  public array $registered = array();
  public array $to_do = array();
  public function all_deps( $handles ) { $this->to_do = $handles; }
};
foreach ( $fixture_prequeued_versions as $index => $version ) {
  $handle = 'unrelated-' . $index;
  $fixture_styles->queue[] = $handle;
  $fixture_styles->registered[$handle] = (object) array( 'ver' => $version );
}
function get_post( $post_id ) { return new WP_Post(); }
function wp_styles() { return $GLOBALS['fixture_styles']; }
function wp_scripts() {}
function do_action( $hook ) {
  if ( 'enqueue_block_assets' !== $hook ) return;
  foreach ( $GLOBALS['fixture_editor_versions'] as $index => $version ) {
    $handle = 'editor-' . $index;
    $GLOBALS['fixture_styles']->queue[] = $handle;
    $GLOBALS['fixture_styles']->registered[$handle] = (object) array( 'ver' => $version );
  }
}
function get_block_editor_settings( $settings, $context ) {
  return array( 'styles' => array_map( static fn ( $css ) => array( 'css' => $css ), $GLOBALS['fixture_inline_css'] ) );
}
function wp_json_encode( $value ) { return json_encode( $value ); }
${editorPresentationContractPhpCode(17)}
`
  try {
    const output = await runCommandText("php", ["-r", php])
    return parseEditorPresentationContract(output) as { identities: string[]; complete: boolean }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

assert.deepEqual(await captureContract([`:root{--blocks-engine-presentation:${inlineIdentity};}`], []), {
  identities: [inlineIdentity.toLowerCase()],
  complete: true,
}, "inline-only delivery remains in the expected contract")

assert.deepEqual(await captureContract([], [externalIdentity.toUpperCase()]), {
  identities: [externalIdentity],
  complete: true,
}, "external-only editor delivery contributes its canonical version identity")

assert.deepEqual(await captureContract([
  `/* --blocks-engine-presentation:${inlineIdentity} */`,
  `/* --blocks-engine-presentation:${externalIdentity} */`,
], [externalIdentity.toUpperCase()]), {
  identities: [inlineIdentity.toLowerCase(), externalIdentity].sort(),
  complete: true,
}, "mixed delivery is normalized, deduplicated, and sorted")

assert.deepEqual(await captureContract([], ["6.7.1", "not-a-hash", ` ${externalIdentity}`, `${externalIdentity}0`, null], [unrelatedIdentity]), {
  identities: [],
  complete: true,
}, "non-hash versions and unrelated prequeued stylesheets are ignored")
