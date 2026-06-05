import assert from "node:assert/strict"

import { phpunitRunCode } from "../packages/runtime-playground/src/commands.js"

const projectBootstrapCode = phpunitRunCode({
  pluginSlug: "project-bootstrap-plugin",
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/project-bootstrap-plugin/phpunit.xml",
  selectedTestFile: "tests/ProjectBootstrapTest.php",
  changedTestFiles: [],
  phpunitArgs: ["--filter", "ProjectBootstrapTest::test_selected"],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: [],
  bootstrapFiles: [],
  bootstrapMode: "project",
  projectBootstrap: "tests/bootstrap.php",
  multisite: false,
})

assert.match(projectBootstrapCode, /\$bootstrap_mode = "project"/)
assert.match(projectBootstrapCode, /\$project_bootstrap = "tests\/bootstrap\.php"/)
assert.match(projectBootstrapCode, /'WP_TESTS_DIR' => \$tests_dir/)
assert.match(projectBootstrapCode, /'WP_TESTS_CONFIG_FILE_PATH' => \$config_path/)
assert.match(projectBootstrapCode, /'WP_PHPUNIT__TESTS_CONFIG' => \$config_path/)
assert.match(projectBootstrapCode, /pg_run_project_bootstrap_stage/)
assert.match(projectBootstrapCode, /PROJECT_BOOTSTRAP:/)
assert.match(projectBootstrapCode, /NOTICE:phpunit filter applied: /)
assert.match(projectBootstrapCode, /ProjectBootstrapTest::test_selected/)

const detectedBootstrapCode = phpunitRunCode({
  pluginSlug: "project-bootstrap-plugin",
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/project-bootstrap-plugin/phpunit.xml.dist",
  selectedTestFile: "tests/ProjectBootstrapTest.php",
  changedTestFiles: [],
  phpunitArgs: ["--filter=ProjectBootstrapTest::test_selected"],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: [],
  bootstrapFiles: [],
  bootstrapMode: "project",
  projectBootstrap: "",
  multisite: false,
})

assert.match(detectedBootstrapCode, /pg_project_bootstrap_from_config/)
assert.match(detectedBootstrapCode, /\$bootstrap = pg_project_bootstrap_from_config/)
assert.match(detectedBootstrapCode, /--filter=/)

console.log("project PHPUnit bootstrap smoke passed")
