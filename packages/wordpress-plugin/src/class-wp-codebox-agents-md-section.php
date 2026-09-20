<?php
/**
 * Composable agent-context section describing WP Codebox.
 *
 * Registers a `WP Codebox` section for the `agents-md` context on the
 * Agents API context section registry so host composers (any consumer of
 * `WP_Agent_Context_Section_Registry`) surface Codebox routing, safety, and
 * discovery guidance to coding agents. The plugin owns the surface, so it owns
 * the guidance; no host-specific composer is referenced here.
 *
 * @package WP_Codebox
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_Codebox_Agents_Md_Section {

	public const CONTEXT_SLUG = 'agents-md';
	public const SECTION_SLUG = 'wp-codebox';
	public const PRIORITY     = 40;

	/**
	 * Hook the registration onto the Agents API context extension point.
	 */
	public static function register(): void {
		add_action( 'agents_api_context_sections', array( self::class, 'register_section' ) );
	}

	/**
	 * Register the section when the substrate registry is loaded.
	 */
	public static function register_section(): void {
		if ( ! class_exists( 'WP_Agent_Context_Section_Registry' ) ) {
			return;
		}

		WP_Agent_Context_Section_Registry::register(
			self::CONTEXT_SLUG,
			self::SECTION_SLUG,
			self::PRIORITY,
			static function (): string {
				return self::render();
			},
			array(
				'label'       => 'WP Codebox',
				'description' => 'Disposable WordPress sandbox CLI and abilities.',
				'meta'        => array(
					'owner'      => 'wp-codebox',
					'freshness'  => 'generated',
					'conditions' => 'Registered when wp-codebox is active and the Agents API context section registry is loaded.',
				),
			)
		);
	}

	/**
	 * WP-CLI invocation prefix used in rendered guidance.
	 *
	 * Defaults to a path-pinned invocation. Hosts that need a different
	 * prefix (flags, wrapper binaries, remote routing) adjust it through the
	 * `wp_codebox_agents_md_wp_cli_cmd` filter.
	 */
	public static function wp_cli_cmd(): string {
		$default = 'wp --path=' . rtrim( (string) ABSPATH, '/\\' );

		$cmd = apply_filters( 'wp_codebox_agents_md_wp_cli_cmd', $default );

		return is_string( $cmd ) && '' !== trim( $cmd ) ? trim( $cmd ) : $default;
	}

	/**
	 * Render the section body.
	 */
	public static function render(): string {
		$wp = self::wp_cli_cmd();

		$lines = array(
			'## WP Codebox',
			'',
			'Disposable WordPress sandboxes for coding-agent tasks, runtime workloads, and fuzzing. They cannot touch the host; they return artifact bundles the host reviews and applies back. Abilities: `wp-codebox/*`. CLI mirrors the same service layer.',
			'',
			'**Default routing**',
			'- Agent task: `' . $wp . ' codebox run-agent-task --goal=\'...\' --format=json`',
			'- Waves: `codebox run-agent-task-batch` / `codebox run-agent-task-fanout`',
			'- Runtime / WordPress workload: `codebox run-runtime-task` / `codebox run-wordpress-workload`',
			'- Readiness: `codebox resolve-runtime-requirements`',
			'- Artifacts: `codebox artifacts list` → `codebox artifacts inspect` → `codebox artifacts preflight-apply` → `stage-apply` → `codebox artifacts apply`',
			'- Playground: `codebox browser-session create`',
			'',
			'**Safety**',
			'- `artifacts apply` mutates the host. Always `preflight-apply` and inspect first; pass only `--approved-files`.',
			'- Credentials via `secret_env` names. Never print secret values in prompts, payloads, logs, or artifacts.',
			'- WP-CLI bypasses ability permission callbacks; shell access is the permission boundary.',
			'',
			'**Discovery**',
			'`' . $wp . ' codebox --help`. Live help is authoritative.',
		);

		return implode( "\n", $lines ) . "\n";
	}
}
