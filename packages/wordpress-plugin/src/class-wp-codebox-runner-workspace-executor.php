<?php
/**
 * Runner workspace tool executor.
 *
 * Binds the codebox-native runner workspace tool engine to a single resolved
 * workspace root and maps agent tool calls to engine operations. This is the
 * `wp-codebox/runner-workspace` executor target: it gives the runner a native
 * git + GitHub + file agent-tool surface so it no longer depends on an external
 * coding-agent plugin for those tools.
 *
 * The executor implements the Agents API WP_Agent_Tool_Executor contract when
 * that interface is available; the pure execute_tool() entrypoint is also
 * callable directly so the tool surface can be exercised deterministically.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

if ( interface_exists( '\\AgentsAPI\\AI\\Tools\\WP_Agent_Tool_Executor' ) ) {
	final class WP_Codebox_Runner_Workspace_Executor implements \AgentsAPI\AI\Tools\WP_Agent_Tool_Executor {
		use WP_Codebox_Runner_Workspace_Executor_Behavior;

		/**
		 * @param array<mixed> $tool_call
		 * @param array<mixed> $tool_definition
		 * @param array<mixed> $context
		 * @return array<mixed>
		 */
		public function executeWP_Agent_Tool_Call( array $tool_call, array $tool_definition, array $context = array() ): array {
			$tool_name  = (string) ( $tool_call['tool_name'] ?? $tool_definition['name'] ?? '' );
			$parameters = is_array( $tool_call['parameters'] ?? null ) ? $tool_call['parameters'] : array();
			$result     = $this->execute_tool( $tool_name, $parameters, $context );

			return array(
				'tool_name' => $tool_name,
				'success'   => ! empty( $result['success'] ),
				'result'    => $result,
				'runtime'   => array(
					'executor_target'      => self::TARGET_ID,
					'side_effect_boundary' => self::SIDE_EFFECT_BOUNDARY,
				),
			);
		}
	}
} else {
	final class WP_Codebox_Runner_Workspace_Executor {
		use WP_Codebox_Runner_Workspace_Executor_Behavior;
	}
}
