<?php
// Intentionally vulnerable reflected output for disposable theme campaigns.
?><!doctype html><html><body><main data-fixture="vulnerable-theme"><?php echo wp_unslash($_GET['message'] ?? 'fixture'); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?></main></body></html>
