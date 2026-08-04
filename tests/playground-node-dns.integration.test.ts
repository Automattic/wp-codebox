import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, "..")
const root = await mkdtemp(join(tmpdir(), "wp-codebox-playground-node-dns-"))
const recipePath = join(root, "recipe.json")

try {
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", phpVersion: "8.4", blueprint: { steps: [] } },
    workflow: {
      steps: [{
        command: "wordpress.run-php",
        args: ["code=" + String.raw`$records = dns_get_record( 'example.com', DNS_A | DNS_AAAA );
$valid_records = array_values( array_filter( $records, static function ( $record ) {
    $address = 'A' === ( $record['type'] ?? '' ) ? ( $record['ip'] ?? '' ) : ( $record['ipv6'] ?? '' );
    return in_array( $record['type'] ?? '', array( 'A', 'AAAA' ), true )
        && false !== filter_var( $address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
} ) );
echo wp_json_encode( array(
    'php_version' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
    'records' => $valid_records,
    'public_url' => wp_http_validate_url( 'https://example.com/' ),
) );`],
      }],
    },
  })}\n`)

  const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], {
    cwd: repositoryRoot,
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const output = JSON.parse(result.stdout) as {
    executions?: Array<{ command?: string; stdout?: string }>
  }
  const stdout = output.executions?.find((execution) => execution.command === "wordpress.run-php")?.stdout
  assert.ok(stdout, "the real WP Codebox runtime must return PHP output")
  const proof = JSON.parse(stdout) as {
    php_version?: string
    records?: Array<{ type?: string; ip?: string; ipv6?: string }>
    public_url?: string | false
  }
  assert.equal(proof.php_version, "8.4", "the proof must exercise the overlaid default programmatic PHP version")
  assert.ok(proof.records && proof.records.length > 0, "dns_get_record() must return at least one public A or AAAA record")
  assert.ok(proof.records.every((record) => (record.type === "A" && record.ip) || (record.type === "AAAA" && record.ipv6)))
  assert.equal(proof.public_url, "https://example.com/", "WordPress must accept the public target after real DNS resolution")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("playground Node DNS integration passed")
