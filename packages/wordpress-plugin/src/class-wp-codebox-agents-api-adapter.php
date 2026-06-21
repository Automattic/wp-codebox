<?php
/**
 * WP Codebox facade for the Agents API ability boundary.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Codebox-owned wrapper around the public Agents API abilities.
 *
 * Consumers should depend on this class instead of importing Agents API constants,
 * handler names, or execution principal internals.
 */
final class WP_Codebox_Agents_API_Adapter {

	public const CHAT                 = 'agents/chat';
	public const RUN_TASK             = 'agents/run-task';
	public const RUN_RUNTIME_PACKAGE  = 'agents/run-runtime-package';
	public const GET_TASK_RUN         = 'agents/get-task-run';
	public const CANCEL_TASK_RUN      = 'agents/cancel-task-run';
	public const GET_CHAT_RUN         = 'agents/get-chat-run';
	public const CANCEL_CHAT_RUN      = 'agents/cancel-chat-run';
	public const QUEUE_CHAT_MESSAGE   = 'agents/queue-chat-message';
	public const LIST_CHAT_RUN_EVENTS = 'agents/list-chat-run-events';

	/** @return array<string,string> */
	public static function ability_names(): array {
		return array(
			'chat'                 => self::CHAT,
			'run_task'             => self::RUN_TASK,
			'run_runtime_package'  => self::RUN_RUNTIME_PACKAGE,
			'get_task_run'         => self::GET_TASK_RUN,
			'cancel_task_run'      => self::CANCEL_TASK_RUN,
			'get_chat_run'         => self::GET_CHAT_RUN,
			'cancel_chat_run'      => self::CANCEL_CHAT_RUN,
			'queue_chat_message'   => self::QUEUE_CHAT_MESSAGE,
			'list_chat_run_events' => self::LIST_CHAT_RUN_EVENTS,
		);
	}

	public function is_available( string $ability_name ): bool {
		return '' !== $ability_name && function_exists( 'wp_get_ability' ) && (bool) wp_get_ability( $ability_name );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function chat( array $input ): array|WP_Error {
		return $this->execute( self::CHAT, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function run_task( array $input ): array|WP_Error {
		return $this->execute( self::RUN_TASK, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function run_runtime_package( array $input ): array|WP_Error {
		return $this->execute( self::RUN_RUNTIME_PACKAGE, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function get_task_run( array $input ): array|WP_Error {
		return $this->execute( self::GET_TASK_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function cancel_task_run( array $input ): array|WP_Error {
		return $this->execute( self::CANCEL_TASK_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function get_chat_run( array $input ): array|WP_Error {
		return $this->execute( self::GET_CHAT_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function cancel_chat_run( array $input ): array|WP_Error {
		return $this->execute( self::CANCEL_CHAT_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function queue_chat_message( array $input ): array|WP_Error {
		return $this->execute( self::QUEUE_CHAT_MESSAGE, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function list_chat_run_events( array $input ): array|WP_Error {
		return $this->execute( self::LIST_CHAT_RUN_EVENTS, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function execute( string $ability_name, array $input ): array|WP_Error {
		if ( '' === $ability_name || ! function_exists( 'wp_get_ability' ) ) {
			return new WP_Error( 'wp_codebox_agents_api_unavailable', 'The Agents API ability registry is unavailable.', array( 'status' => 500, 'ability' => $ability_name ) );
		}

		$ability = wp_get_ability( $ability_name );
		if ( ! $ability || ! method_exists( $ability, 'execute' ) ) {
			return new WP_Error( 'wp_codebox_agents_api_ability_unavailable', 'The requested Agents API ability is unavailable.', array( 'status' => 500, 'ability' => $ability_name ) );
		}

		$result = $ability->execute( $input );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		if ( ! is_array( $result ) ) {
			return new WP_Error( 'wp_codebox_agents_api_invalid_result', 'The requested Agents API ability returned an invalid result.', array( 'status' => 500, 'ability' => $ability_name ) );
		}

		return $result;
	}
}
