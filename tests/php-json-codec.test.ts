import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const output = execFileSync(
  "php",
  [
    "-r",
    String.raw`
define('ABSPATH', __DIR__ . '/');
require __DIR__ . '/packages/wordpress-plugin/src/class-wp-codebox-json.php';

$tmp = sys_get_temp_dir() . '/wp-codebox-json-' . bin2hex(random_bytes(4));
mkdir($tmp);

$pretty = WP_Codebox_Json::encode(array('path' => 'files/result.json'), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
$object = WP_Codebox_Json::decode_object('{"ok":true}');
$list = WP_Codebox_Json::decode_list('["a","b"]');
$trailing = WP_Codebox_Json::decode_trailing_array("warning\n{\"status\":\"ok\"}");
$fragment = WP_Codebox_Json::decode_fragment_array("prefix {\"result\":{\"ok\":true}} suffix");

WP_Codebox_Json::write_file($tmp . '/nested/result.json', array('ok' => true), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
WP_Codebox_Json::append_jsonl($tmp . '/events.jsonl', array('event' => 'one'), JSON_UNESCAPED_SLASHES);
WP_Codebox_Json::append_jsonl($tmp . '/events.jsonl', array('event' => 'two'), JSON_UNESCAPED_SLASHES);

echo json_encode(array(
	'pretty' => $pretty,
	'object' => $object,
	'list' => $list,
	'trailing' => $trailing,
	'fragment' => $fragment,
	'file' => file_get_contents($tmp . '/nested/result.json'),
	'events' => file($tmp . '/events.jsonl', FILE_IGNORE_NEW_LINES),
), JSON_UNESCAPED_SLASHES);
`,
  ],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" }
)

const result = JSON.parse(output)

assert.match(result.pretty, /"path": "files\/result\.json"/)
assert.deepEqual(result.object, { ok: true })
assert.deepEqual(result.list, ["a", "b"])
assert.deepEqual(result.trailing, { status: "ok" })
assert.deepEqual(result.fragment, { result: { ok: true } })
assert.equal(result.file, "{\n    \"ok\": true\n}\n")
assert.deepEqual(result.events, ['{"event":"one"}', '{"event":"two"}'])
