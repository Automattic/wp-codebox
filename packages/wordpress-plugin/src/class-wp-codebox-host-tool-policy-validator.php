<?php
/**
 * Host-side validation for sandbox tool policy snapshots.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Tool_Policy_Validator {

	private WP_Codebox_Sandbox_Tool_Policy_Normalizer $normalizer;
	private WP_Codebox_Runtime_Tool_Policy_Descriptor $descriptor_resolver;

	public function __construct() {
		$this->normalizer          = new WP_Codebox_Sandbox_Tool_Policy_Normalizer();
		$this->descriptor_resolver = new WP_Codebox_Runtime_Tool_Policy_Descriptor();
	}

	/** @param string[] $tools @param array<string,mixed>|null $task_input Normalized task input. */
	public function validate_allowed_tools( array $tools, ?array $task_input = null ): WP_Error|null {
		return $this->validate_task_tools( is_array( $task_input ) ? $task_input : array( 'allowed_tools' => $tools ) );
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	public function validate_task_tools( array $task_input ): WP_Error|null {
		return $this->normalizer->validate_task_tools( WP_Codebox_Agent_Task::string_list( $task_input['allowed_tools'] ?? array() ), $task_input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function resolved_policy( array $input ): array|WP_Error {
		return $this->normalizer->normalize_for_task_input( $input );
	}

	/** @param array<string,mixed> $policy @return array<int,array<string,string>> */
	public function policy_issues( array $policy ): array {
		return $this->normalizer->policy_issues( $policy );
	}

	/** @param array<string,mixed> $policy @return string[] */
	public function allowed_tools( array $policy ): array {
		return $this->normalizer->allowed_tools( $policy );
	}

	/** @param array<string,mixed> $policy @return array<string,mixed>|null */
	public function policy_tool( array $policy, string $tool_id ): array|null {
		return $this->descriptor_resolver->resolve_runtime_tool_alias( $policy, $tool_id );
	}

	/** @param array<string,mixed> $tool */
	public function denial_reason( array $tool ): string|null {
		return $this->descriptor_resolver->denial_reason( $tool );
	}

	/** @param array<string,mixed> $tool @return array{environment:string,capability_scope:string} */
	public function runtime_metadata( array $tool ): array {
		return $this->descriptor_resolver->runtime_metadata( $tool );
	}
}
