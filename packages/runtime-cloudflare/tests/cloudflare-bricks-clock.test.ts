import test from "node:test";
import assert from "node:assert/strict";
import { patchBricksRandomIds, restoreBricksSettings } from "../src/bricks-clock-compatibility.js";

test("Bricks ID compatibility replaces only entropy generation and is idempotent", () => {
  const source = `public static function generate_random_id( $echo = true ) {
    $hash = self::generate_hash( md5( uniqid( rand(), true ) ) );
    if ( $echo ) echo $hash;
    return $hash;
  }`;
  const patched = patchBricksRandomIds(source);
  assert.equal(patched, source.replace("md5( uniqid( rand(), true ) )", "bin2hex( random_bytes( 16 ) )"));
  assert.equal(patchBricksRandomIds(patched), patched);
  assert.throws(() => patchBricksRandomIds(source + source), /Unsupported/);
  assert.throws(() => patchBricksRandomIds("different implementation"), /Unsupported/);
});

test("Settings dependency initialization moves outside interactive guard", () => {
  const source = "\t\tif ( $is_interactive ) {\n\t\t\t$this->ajax = new Ajax();\n\t\t\t$this->settings = new Settings();\n\t\t}\n\t\t$this->templates = new Templates();";
  const patched = restoreBricksSettings(source);
  assert.match(patched, /}\n\t\t\$this->templates = new Templates\(\);\n\t\t\$this->settings = new Settings\(\);$/);
  assert.equal(restoreBricksSettings(patched), patched);
  assert.throws(() => restoreBricksSettings(source + source), /Unsupported/);
});
