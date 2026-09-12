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
			'WP Codebox launches disposable, isolated WordPress sandboxes for coding-agent tasks, runtime workloads, and fuzzing. Sandboxes cannot touch the host site; they produce artifact bundles (changed files, patches, evidence) that the host reviews and applies back explicitly. Abilities live under `wp-codebox/*`; the CLI mirrors the same PHP service layer.',
			'',
			'**Default routing**',
			'- Run a bounded coding task in a sandbox: `' . $wp . ' codebox run-agent-task --goal=\'...\' --format=json`',
			'- Independent task waves: `' . $wp . ' codebox run-agent-task-batch --input-file=<batch.json>` or `' . $wp . ' codebox run-agent-task-fanout --input-file=<fanout.json>`',
			'- Run a runtime task or WordPress workload: `' . $wp . ' codebox run-runtime-task --input-json=\'{...}\'` or `' . $wp . ' codebox run-wordpress-workload --input-file=<workload.json>`',
			'- Check runtime/provider readiness before dispatch: `' . $wp . ' codebox resolve-runtime-requirements --format=json`',
			'- Review what a sandbox produced: `' . $wp . ' codebox artifacts list --format=json`, then `' . $wp . ' codebox artifacts inspect <artifact_id> --format=json`',
			'- Apply reviewed changes to the host: `' . $wp . ' codebox artifacts preflight-apply <artifact_id>` → `' . $wp . ' codebox artifacts stage-apply <artifact_id> --approved-files=...` → `' . $wp . ' codebox artifacts apply <artifact_id> --approved-files=...`',
			'- Browser-executed Playground session: `' . $wp . ' codebox browser-session create --goal=\'...\' --format=json`',
			'',
			'**Safety**',
			'- `artifacts apply` mutates the host through the configured apply-back adapter. Always `preflight-apply` and review `inspect` output first; pass only the files you approved via `--approved-files`.',
			'- Provider credentials reach sandboxes through `secret_env` names. Never print secret values in prompts, task payloads, logs, or artifacts.',
			'- WP-CLI runs in trusted operator context and bypasses ability permission callbacks; shell access is the permission boundary.',
			'',
			'**Discovery**',
			'Use `' . $wp . ' codebox --help` and `' . $wp . ' codebox <command> --help` for the live command contract; `--input-json` / `--input-file` carry complex payloads and CLI flags override payload fields. Inspect `' . $wp . ' codebox runtime descriptor --format=json` for the registered runtime profile. Live `--help` output is authoritative.',
		);

		return implode( "\n", $lines ) . "\n";
	}
}
