<?php

define( 'ABSPATH', __DIR__ );

final class WP_Error {
    private string $code;
    private string $message;
    /** @var array<string,mixed> */
    private array $data;

    /** @param array<string,mixed> $data */
    public function __construct( string $code = '', string $message = '', array $data = array() ) {
        $this->code    = $code;
        $this->message = $message;
        $this->data    = $data;
    }

    public function get_error_code(): string {
        return $this->code;
    }

    public function get_error_message(): string {
        return $this->message;
    }

    /** @return array<string,mixed> */
    public function get_error_data(): array {
        return $this->data;
    }
}

function is_wp_error( mixed $value ): bool {
    return $value instanceof WP_Error;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-json.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-path-policy.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-redaction-policy.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-host-recipe-builder.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-run-plan.php';

$fixture = json_decode( file_get_contents( __DIR__ . '/../tests/fixtures/primitive-contracts.json' ), true );
if ( ! is_array( $fixture ) ) {
    fwrite( STDERR, "Invalid primitive contracts fixture.\n" );
    exit( 1 );
}

function assert_same_contract( mixed $expected, mixed $actual, string $label ): void {
    if ( $expected !== $actual ) {
        fwrite( STDERR, $label . " failed.\nExpected: " . json_encode( $expected, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\nActual: " . json_encode( $actual, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\n" );
        exit( 1 );
    }
}

foreach ( $fixture['redaction']['profiles'] as $profile => $contract ) {
    assert_same_contract( $contract['expected'], WP_Codebox_Redaction_Policy::redact_array( $profile, $contract['input'] ), $profile . ' redaction contract' );
}

foreach ( $fixture['pathPolicy']['mountTargets'] as $contract ) {
    $actual = WP_Codebox_Path_Policy::normalize_sandbox_mount_target( $contract['input'] );
    if ( ! empty( $contract['error'] ) ) {
        if ( ! is_wp_error( $actual ) ) {
            fwrite( STDERR, 'Expected mount target error for ' . $contract['input'] . "\n" );
            exit( 1 );
        }
    } else {
        assert_same_contract( $contract['expected'], $actual, 'mount target contract' );
    }
}

foreach ( $fixture['pathPolicy']['artifactPaths'] as $contract ) {
    $actual = WP_Codebox_Path_Policy::normalize_artifact_relative_path( $contract['input'] );
    if ( ! empty( $contract['error'] ) ) {
        if ( ! is_wp_error( $actual ) ) {
            fwrite( STDERR, 'Expected artifact path error for ' . $contract['input'] . "\n" );
            exit( 1 );
        }
    } else {
        assert_same_contract( $contract['expected'], $actual, 'artifact path contract' );
    }
}

$descriptor = new WP_Codebox_Runtime_Tool_Policy_Descriptor();
$effective  = $descriptor->resolve_effective_runtime_tool_policy( $fixture['toolPolicy']['snapshot'] );
assert_same_contract(
    $fixture['toolPolicy']['effective'],
    array(
        'schema'                   => $effective['schema'],
        'version'                  => $effective['version'],
        'allowedRuntimeToolIds'    => $effective['allowedRuntimeToolIds'],
        'visibleRuntimeToolIds'    => $effective['visibleRuntimeToolIds'],
        'parentOnlyRuntimeToolIds' => $effective['parentOnlyRuntimeToolIds'],
        'hiddenRuntimeToolIds'     => $effective['hiddenRuntimeToolIds'],
        'metadata'                 => $effective['metadata'],
    ),
    'tool policy effective contract'
);
foreach ( $fixture['toolPolicy']['aliases'] as $alias => $runtime_tool_id ) {
    assert_same_contract( $runtime_tool_id, $descriptor->resolve_runtime_tool_alias( $effective, $alias )['runtimeToolId'] ?? null, $alias . ' alias contract' );
}

$json_codec = $fixture['jsonCodec'];
assert_same_contract( $json_codec['prettyExpected'], WP_Codebox_Json::encode( $json_codec['prettyValue'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ), 'json pretty encode contract' );
assert_same_contract( $json_codec['expected']['object'], WP_Codebox_Json::decode_object( $json_codec['object'] ), 'json object decode contract' );
assert_same_contract( $json_codec['expected']['list'], WP_Codebox_Json::decode_list( $json_codec['list'] ), 'json list decode contract' );
assert_same_contract( $json_codec['expected']['trailing'], WP_Codebox_Json::decode_trailing_array( $json_codec['trailing'] ), 'json trailing decode contract' );
assert_same_contract( $json_codec['expected']['fragment'], WP_Codebox_Json::decode_fragment_array( $json_codec['fragment'] ), 'json fragment decode contract' );

$runtime_input = $fixture['runtimeDependencyPlan']['input'];
$plan          = new WP_Codebox_Runtime_Dependency_Plan(
    $runtime_input['selection'],
    $runtime_input['provider_plugin_paths'],
    $runtime_input['provider_plugins'],
    $runtime_input['component_plugins'],
    $runtime_input['runtime_overlays'],
    $runtime_input['inheritance'],
    $runtime_input['inheritance_request'],
    $runtime_input['agent_bundles'],
    $runtime_input['secret_env'],
    $runtime_input['runtime_env']
);
assert_same_contract( $fixture['runtimeDependencyPlan']['expected'], $plan->to_contract(), 'runtime dependency plan contract' );

$component_manifest = new ReflectionMethod( WP_Codebox_Host_Recipe_Builder::class, 'component_manifest' );
assert_same_contract(
    $fixture['componentManifest']['expected'],
    $component_manifest->invoke( null, $fixture['componentManifest']['components'], $fixture['componentManifest']['providers'] ),
    'component manifest contract'
);

$run_plan = new WP_Codebox_Run_Plan();
assert_same_contract( $fixture['runPlan']['counts'], $run_plan->result_counts( $fixture['runPlan']['children'] ), 'run-plan result counts' );
assert_same_contract( $fixture['runPlan']['succeeded'], $run_plan->succeeded( $fixture['runPlan']['counts'] ), 'run-plan succeeded contract' );
assert_same_contract( $fixture['runPlan']['concurrency']['defaulted'], $run_plan->normalize_concurrency( '', array( 'default_concurrency' => 3, 'max_concurrency' => 5 ) ), 'run-plan default concurrency' );
assert_same_contract( $fixture['runPlan']['concurrency']['clamped'], $run_plan->normalize_concurrency( 99, array( 'max_concurrency' => 2 ) ), 'run-plan clamped concurrency' );

fwrite( STDOUT, "PHP primitive contract parity smoke passed\n" );
