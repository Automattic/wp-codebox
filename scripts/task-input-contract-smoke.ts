import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { normalizeTaskInput, TASK_INPUT_JSON_SCHEMA, TASK_INPUT_SCHEMA, TASK_INPUT_VERSION } from "@automattic/wp-codebox-core"

interface Fixture {
  name: string
  input: Parameters<typeof normalizeTaskInput>[0]
  normalized: ReturnType<typeof normalizeTaskInput>
}

const fixtures = JSON.parse(await readFile(new URL("../tests/fixtures/task-input-normalization.json", import.meta.url), "utf8")) as Fixture[]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(TASK_INPUT_JSON_SCHEMA.$id === TASK_INPUT_SCHEMA, "Task input schema id drifted.")
assert(TASK_INPUT_JSON_SCHEMA.properties.version.const === TASK_INPUT_VERSION, "Task input schema version drifted.")
assert(TASK_INPUT_JSON_SCHEMA.required.includes("structured_artifacts"), "TS task input schema must require structured_artifacts.")
assert(
  "import_principal" in TASK_INPUT_JSON_SCHEMA.properties.agent_bundles.items.properties,
  "TS agent bundle schema must include import_principal.",
)

for (const fixture of fixtures) {
  const normalized = normalizeTaskInput(fixture.input)
  if (JSON.stringify(normalized) !== JSON.stringify(fixture.normalized)) {
    throw new Error(`Task input fixture failed: ${fixture.name}`)
  }
}

const contractPath = new URL("../packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php", import.meta.url)
const fixturePath = new URL("../tests/fixtures/task-input-normalization.json", import.meta.url)
const php = spawnSync("php", ["-r", `
define('ABSPATH', __DIR__);
require ${JSON.stringify(contractPath.pathname)};
$fixtures = json_decode(file_get_contents(${JSON.stringify(fixturePath.pathname)}), true, 512, JSON_THROW_ON_ERROR);
$schema = WP_Codebox_Task_Input_Contract::schema();
$normalized = WP_Codebox_Task_Input_Contract::normalize($fixtures[0]['input']);
echo json_encode(array(
    'required' => $schema['required'],
    'agent_bundle_properties' => array_keys($schema['properties']['agent_bundles']['items']['properties']),
    'has_structured_artifacts_schema' => isset($schema['properties']['structured_artifacts']),
    'normalized' => $normalized,
), JSON_THROW_ON_ERROR);
`], { encoding: "utf8" })

assert(php.status === 0, `PHP task input contract smoke failed: ${php.stderr || php.stdout}`)

const phpContract = JSON.parse(php.stdout) as {
  required: string[]
  agent_bundle_properties: string[]
  has_structured_artifacts_schema: boolean
  normalized: ReturnType<typeof normalizeTaskInput>
}

assert(phpContract.required.includes("structured_artifacts"), "PHP task input schema must require structured_artifacts.")
assert(phpContract.agent_bundle_properties.includes("import_principal"), "PHP agent bundle schema must include import_principal.")
assert(phpContract.has_structured_artifacts_schema, "PHP task input schema must define structured_artifacts.")
assert(phpContract.normalized.structured_artifacts[0]?.provenance?.direction === "input", "PHP must normalize input structured_artifacts.")
assert(phpContract.normalized.agent_bundles[0]?.import_principal?.agent_id === 12, "PHP must normalize agent bundle import_principal.")

console.log(`task input contract smoke ok (${fixtures.length} fixtures)`)
