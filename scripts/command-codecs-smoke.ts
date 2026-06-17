import assert from "node:assert/strict"
import { commandArg, commandJsonArg, commandStringListArg, parseCommandJsonArray, parseCommandJsonObject, parseCommandOptions, parseCommandStringList } from "@automattic/wp-codebox-core"

assert.equal(commandArg("name", "value=with=equals"), "name=value=with=equals")
assert.equal(commandJsonArg("payload-json", { ok: true, nested: ["a=b"] }), 'payload-json={"ok":true,"nested":["a=b"]}')
assert.equal(commandStringListArg("items", [" a ", "", "b"]), "items=a,b")
assert.deepEqual(parseCommandStringList(" a, ,b "), ["a", "b"])
assert.deepEqual(parseCommandJsonObject('{"ok":true}', "payload-json"), { ok: true })
assert.deepEqual(parseCommandJsonObject(undefined, "payload-json"), {})
assert.deepEqual(parseCommandJsonArray('["x"]', "items-json"), ["x"])
assert.throws(() => parseCommandJsonObject("[]", "payload-json"), /payload-json must be a JSON object/)
assert.throws(() => parseCommandJsonArray("{}", "items-json"), /items-json must be a JSON array/)
assert.throws(() => parseCommandJsonObject("{", "payload-json"), /payload-json must be valid JSON/)

const parsed = parseCommandOptions(["--recipe=recipe=a.json", "--json", "--artifacts", "out", "positional"], new Set(["--json"]))
assert.equal(parsed.options.get("--recipe"), "recipe=a.json")
assert.equal(parsed.options.get("--json"), true)
assert.equal(parsed.options.get("--artifacts"), "out")
assert.deepEqual(parsed.positionals, ["positional"])
assert.equal(parseCommandOptions(["--label", "--literal"]).options.get("--label"), "--literal")
assert.throws(() => parseCommandOptions(["--json=true"], new Set(["--json"])), /--json does not accept a value/)
assert.throws(() => parseCommandOptions(["--recipe"]), /Missing value for option: --recipe/)

console.log("command-codecs-smoke passed")
