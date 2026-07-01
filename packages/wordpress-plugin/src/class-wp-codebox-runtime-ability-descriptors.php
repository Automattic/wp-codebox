<?php
/**
 * Runtime ability descriptors.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Provides runtime, workload, fuzz, and package ability descriptors.
 */
final class WP_Codebox_Runtime_Ability_Descriptors {

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function run_runtime_task( array $context ): array {
		return array(
			'label'               => 'Run Runtime Task',
			'description'         => 'Run a runtime task through the WP Codebox boundary and return a stable wp-codebox result envelope.',
			'category'            => 'wp-codebox',
			'input_schema'        => $context['runtime_task_request_schema'],
			'output_schema'       => $context['runtime_task_result_schema'],
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'run_runtime_task' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true, 'canonical_ability' => 'wp-codebox/run-runtime-task' ),
		);
	}

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function run_wordpress_workload( array $context ): array {
		return array(
			'label'               => 'Run WordPress Workload',
			'description'         => 'Run a safe recipe-backed WordPress workload and return step results, diagnostics, and artifact references without accepting raw PHP or shell input.',
			'category'            => 'wp-codebox',
			'input_schema'        => $context['wordpress_workload_run_request_schema'],
			'output_schema'       => $context['wordpress_workload_run_result_schema'],
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'run_wordpress_workload' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true, 'canonical_ability' => 'wp-codebox/run-wordpress-workload' ),
		);
	}

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function run_fuzz_suite( array $context ): array {
		return array(
			'label'               => 'Run Fuzz Suite',
			'description'         => 'Run safe PHP in-process WordPress fuzz-suite cases against this disposable runtime and return structured case results plus artifact references. Runtime-backed execution is available through the public wp-codebox CLI or TypeScript facade, not this ability callback.',
			'category'            => 'wp-codebox',
			'input_schema'        => $context['fuzz_suite_request_schema'],
			'output_schema'       => $context['fuzz_suite_result_schema'],
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'run_fuzz_suite' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true, 'canonical_ability' => 'wp-codebox/run-fuzz-suite', 'wordpress_fuzz_runtime_contract' => WP_Codebox_API::wordpress_fuzz_runtime_contract(), 'runner_capabilities' => $context['fuzz_suite_runner_capabilities_contract'], 'supported_runner_capabilities' => $context['fuzz_suite_supported_runner_capabilities'], 'runtime_backed_execution' => $context['fuzz_suite_runtime_backed_execution_contract'], 'runner_capabilities_schema' => $context['fuzz_runner_capabilities_schema'] ),
		);
	}

	/**
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function resolve_runtime_requirements(): array {
		return array(
			'label'               => 'Resolve Runtime Requirements',
			'description'         => 'Resolve runtime/provider readiness without creating a session or invoking a runtime package.',
			'category'            => 'wp-codebox',
			'input_schema'        => array( 'type' => 'object' ),
			'output_schema'       => array( 'type' => 'object' ),
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'resolve_runtime_requirements' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true, 'canonical_ability' => 'wp-codebox/resolve-runtime-requirements' ),
		);
	}

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function run_runtime_package( array $context ): array {
		return array(
			'label'               => 'Run Runtime Package',
			'description'         => 'Run a runtime package through the WP Codebox public runtime boundary using the configured runtime provider.',
			'category'            => 'wp-codebox',
			'input_schema'        => $context['runtime_package_task_schema'],
			'output_schema'       => $context['runtime_package_result_schema'],
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'run_runtime_package' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true, 'canonical_ability' => 'wp-codebox/run-runtime-package', 'backend_adapter' => 'codebox-runtime-package' ),
		);
	}
}
