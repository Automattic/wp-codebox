import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const execFileAsync = promisify(execFile)

const result = await runPhpJson<{
  success: boolean
  schema: string
  png_base64: string
  invalid_route: string
  invalid_archive: string
}>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
 public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function apply_filters( $hook, $value ) {
 if ( 'wp_codebox_bin' === $hook ) {
  return ${phpStringLiteral(`${repoRoot}/packages/cli/dist/index.js`)};
 }
 return $value;
}

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-managed-host-command.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-zip-archive-validator.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-viewport-replay.php`)};

$runner = new WP_Codebox_Browser_Viewport_Replay();
$archive = base64_encode( "PK\\x03\\x04fixture" );
$invalid_route = $runner->run( array( 'archive_base64' => $archive, 'route' => 'https://example.test', 'viewport' => array( 'width' => 390, 'height' => 844 ) ) );
$invalid_archive = $runner->run( array( 'archive_base64' => base64_encode( 'nope' ), 'route' => '/', 'viewport' => array( 'width' => 390, 'height' => 844 ) ) );
echo json_encode(
 array(
   'invalid_route' => $invalid_route->code,
   'invalid_archive' => $invalid_archive->code,
 )
);
`)

assert.equal(result.invalid_route, "wp_codebox_viewport_replay_route_invalid")
assert.equal(result.invalid_archive, "wp_codebox_viewport_replay_archive_invalid")

const archivePolicy = await runPhpJson<{ traversal: string; zip64: string }>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
 public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-zip-archive-validator.php`)};
$path = tempnam( sys_get_temp_dir(), 'wp-codebox-archive-policy-' );
$zip = new ZipArchive();
$zip->open( $path, ZipArchive::CREATE | ZipArchive::OVERWRITE );
$zip->addFromString( '../escape.php', '<?php' );
$zip->close();
$traversal = WP_Codebox_Zip_Archive_Validator::validate( file_get_contents( $path ) );
@unlink( $path );
$zip64 = WP_Codebox_Zip_Archive_Validator::validate( "PK\\x03\\x04PK\\x06\\x07" );
echo json_encode( array( 'traversal' => $traversal->code, 'zip64' => $zip64->code ) );
`)
assert.equal(archivePolicy.traversal, "wp_codebox_zip_archive_invalid")
assert.equal(archivePolicy.zip64, "wp_codebox_zip_archive_invalid")

const root = await mkdtemp(join(tmpdir(), "wp-codebox-browser-viewport-replay-"))
try {
  const exportRoot = join(root, "export")
  const archivePath = join(root, "site.zip")
  await mkdir(join(exportRoot, "wp-content", "mu-plugins"), { recursive: true })
  await writeFile(join(exportRoot, "wp-content", "mu-plugins", "viewport-replay.php"), "<?php\n")
  await execFileAsync("zip", ["-q", "-r", archivePath, "wp-content"], { cwd: exportRoot })

  const capture = await runPhpJson<{
    success: boolean
    schema: string
    png_base64: string
  }>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
 public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function apply_filters( $hook, $value ) {
 if ( 'wp_codebox_bin' === $hook ) {
  return ${phpStringLiteral(`${repoRoot}/packages/cli/dist/index.js`)};
 }
 return $value;
}

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-managed-host-command.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-zip-archive-validator.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-viewport-replay.php`)};

$capture = ( new WP_Codebox_Browser_Viewport_Replay() )->run(
 array(
  'archive_base64' => ${phpStringLiteral((await readFile(archivePath)).toString("base64"))},
  'route' => '/',
  'viewport' => array( 'width' => 390, 'height' => 844 ),
   'timeout_ms' => 120000,
  'wp_version' => '6.8',
  'php_version' => '8.3',
 )
);
if ( is_wp_error( $capture ) ) {
 fwrite( STDERR, $capture->code . ': ' . $capture->message . ' ' . wp_json_encode( $capture->data ) );
 exit( 1 );
}
echo wp_json_encode( $capture );
`)

  assert.equal(capture.success, true)
  assert.equal(capture.schema, "wp-codebox/browser-viewport-replay-result/v1")
  assert.deepEqual(Buffer.from(capture.png_base64, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("browser viewport replay ok")
