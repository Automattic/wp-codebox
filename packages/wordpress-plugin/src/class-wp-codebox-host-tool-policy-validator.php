<?php
/**
 * Host-side validation for sandbox tool policy snapshots.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Tool_Policy_Validator {

	private WP_Codebox_Sandbox_Tool_Policy_Normalizer $normalizer;

	public function __construct() {
		$this->normalizer = new WP_Codebox_Sandbox_Tool_Policy_Normalizer();
	}

	/** @param string[] $tools @param array<string,mixed>|null $task_input Normalized task input. */
	public function validate_allowed_tools( array $tools, ?array $task_input = null ): WP_Error|null {
		return $this->validate_task_tools( is_array( $task_input ) ? $task_input : array( 'allowed_tools' => $tools ) );
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	public function validate_task_tools( array $task_input ): WP_Error|null {
		return $this->normalizer->validate_task_tools( $this->string_list( $task_input['allowed_tools'] ?? array() ), $task_input );
	}

	/** @return string[] */
	private function string_list( mixed $values ): array {
		if ( ! is_array( $values ) ) {
			return array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $value ): string => trim( (string) $value ),
						$values
					),
					static fn( string $value ): bool => '' !== $value
				)
			)
		);
	}
}
