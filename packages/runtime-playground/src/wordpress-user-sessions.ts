import { isPlainObject as isRecord } from "@automattic/wp-codebox-core/internals"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { argValue } from "./command-args.js"

export interface WordPressFixtureUserSpec {
  name?: string
  userId?: number
  username?: string
  email?: string
  role?: string
  displayName?: string
  password?: string
  metadata?: Record<string, unknown>
}

export interface WordPressUserSessionArtifactMetadata {
  kind: string
  path?: string
  redactionRequired: true
  metadata?: Record<string, unknown>
}

export interface WordPressUserSessionResolution {
  source: "user" | "session"
  name: string
  user: WordPressFixtureUserSpec
  metadata: {
    schema: "wp-codebox/wordpress-user-session/v1"
    source: "user" | "session"
    name: string
    user: {
      name?: string
      userId?: number
      username?: string
      email?: string
      role: string
    }
    artifacts: WordPressUserSessionArtifactMetadata[]
    redactionRequired: boolean
  }
}

export function wordpressUserSessionFromCommandArgs(args: string[], runtimeSpec: RuntimeCreateSpec): WordPressUserSessionResolution | undefined {
  const sessionName = argValue(args, "session")?.trim()
  const userName = argValue(args, "user")?.trim()
  if (!sessionName && !userName) {
    return undefined
  }

  const recipeInputs = recipeInputRecord(runtimeSpec)
  const fixtureUsers = Array.isArray(recipeInputs.fixtureUsers) ? recipeInputs.fixtureUsers.filter(isRecord) : []
  const userSessions = Array.isArray(recipeInputs.userSessions) ? recipeInputs.userSessions.filter(isRecord) : []

  if (sessionName) {
    const session = userSessions.find((candidate) => candidate.name === sessionName)
    if (!session) {
      throw new Error(`Unknown WordPress recipe user session: ${sessionName}`)
    }
    const referencedUser = typeof session.user === "string" ? session.user : ""
    const user = fixtureUsers.find((candidate) => candidate.name === referencedUser)
    if (!user) {
      throw new Error(`WordPress recipe user session ${sessionName} references unknown fixture user: ${referencedUser}`)
    }
    return wordpressUserSessionResolution("session", sessionName, user, Array.isArray(session.artifacts) ? session.artifacts : [])
  }

  const user = fixtureUsers.find((candidate) => candidate.name === userName)
  if (!user || !userName) {
    throw new Error(`Unknown WordPress recipe fixture user: ${userName ?? ""}`)
  }
  return wordpressUserSessionResolution("user", userName, user, [])
}

export function wordpressFixtureUserPhpCode(user: WordPressFixtureUserSpec): string {
  return `
$wp_codebox_fixture_user = json_decode( ${JSON.stringify(JSON.stringify(user))}, true );
if ( ! is_array( $wp_codebox_fixture_user ) ) {
    $wp_codebox_fixture_user = array();
}
$wp_codebox_requested_user_id = isset( $wp_codebox_fixture_user['userId'] ) ? (int) $wp_codebox_fixture_user['userId'] : 0;
$wp_codebox_username = isset( $wp_codebox_fixture_user['username'] ) && is_string( $wp_codebox_fixture_user['username'] ) && '' !== trim( $wp_codebox_fixture_user['username'] ) ? sanitize_user( $wp_codebox_fixture_user['username'], true ) : sanitize_user( (string) ( $wp_codebox_fixture_user['name'] ?? 'wp-codebox-fixture-user' ), true );
if ( '' === $wp_codebox_username ) {
    throw new RuntimeException( 'Fixture user username is invalid.' );
}
$wp_codebox_role = isset( $wp_codebox_fixture_user['role'] ) && is_string( $wp_codebox_fixture_user['role'] ) && '' !== trim( $wp_codebox_fixture_user['role'] ) ? sanitize_key( $wp_codebox_fixture_user['role'] ) : 'administrator';
if ( ! get_role( $wp_codebox_role ) ) {
    throw new RuntimeException( 'Fixture user role does not exist: ' . $wp_codebox_role );
}
$wp_codebox_email = isset( $wp_codebox_fixture_user['email'] ) && is_string( $wp_codebox_fixture_user['email'] ) && is_email( $wp_codebox_fixture_user['email'] ) ? $wp_codebox_fixture_user['email'] : $wp_codebox_username . '@example.test';
$wp_codebox_display_name = isset( $wp_codebox_fixture_user['displayName'] ) && is_string( $wp_codebox_fixture_user['displayName'] ) && '' !== trim( $wp_codebox_fixture_user['displayName'] ) ? $wp_codebox_fixture_user['displayName'] : $wp_codebox_username;
$wp_codebox_password = isset( $wp_codebox_fixture_user['password'] ) && is_string( $wp_codebox_fixture_user['password'] ) && '' !== $wp_codebox_fixture_user['password'] ? $wp_codebox_fixture_user['password'] : wp_generate_password( 32, true, true );
$wp_codebox_user_created = false;
$wp_codebox_user = $wp_codebox_requested_user_id > 0 ? get_user_by( 'id', $wp_codebox_requested_user_id ) : get_user_by( 'login', $wp_codebox_username );
if ( ! $wp_codebox_user && $wp_codebox_requested_user_id <= 0 ) {
    $wp_codebox_user_id = wp_insert_user(
        array(
            'user_login'   => $wp_codebox_username,
            'user_email'   => $wp_codebox_email,
            'user_pass'    => $wp_codebox_password,
            'display_name' => $wp_codebox_display_name,
            'role'         => $wp_codebox_role,
        )
    );
    if ( is_wp_error( $wp_codebox_user_id ) ) {
        throw new RuntimeException( 'Fixture user creation failed: ' . $wp_codebox_user_id->get_error_message() );
    }
    $wp_codebox_user_created = true;
    $wp_codebox_user = get_user_by( 'id', (int) $wp_codebox_user_id );
}
if ( ! $wp_codebox_user ) {
    throw new RuntimeException( 'Fixture user could not be resolved.' );
}
$wp_codebox_user_id = (int) $wp_codebox_user->ID;
$wp_codebox_wp_user = new WP_User( $wp_codebox_user_id );
if ( ! in_array( $wp_codebox_role, (array) $wp_codebox_wp_user->roles, true ) ) {
    $wp_codebox_wp_user->add_role( $wp_codebox_role );
}
wp_set_current_user( $wp_codebox_user_id );`
}

function wordpressUserSessionResolution(source: "user" | "session", name: string, user: Record<string, unknown>, artifacts: unknown[]): WordPressUserSessionResolution {
  const normalizedUser = normalizeFixtureUser(user)
  const normalizedArtifacts = artifacts.filter(isRecord).map((artifact) => ({
    kind: typeof artifact.kind === "string" ? artifact.kind : "unknown",
    ...(typeof artifact.path === "string" ? { path: artifact.path } : {}),
    redactionRequired: true as const,
    ...(isRecord(artifact.metadata) ? { metadata: artifact.metadata } : {}),
  }))

  return {
    source,
    name,
    user: normalizedUser,
    metadata: {
      schema: "wp-codebox/wordpress-user-session/v1",
      source,
      name,
      user: {
        ...(normalizedUser.name ? { name: normalizedUser.name } : {}),
        ...(normalizedUser.userId ? { userId: normalizedUser.userId } : {}),
        ...(normalizedUser.username ? { username: normalizedUser.username } : {}),
        ...(normalizedUser.email ? { email: normalizedUser.email } : {}),
        role: normalizedUser.role ?? "administrator",
      },
      artifacts: normalizedArtifacts,
      redactionRequired: normalizedArtifacts.length > 0,
    },
  }
}

function normalizeFixtureUser(user: Record<string, unknown>): WordPressFixtureUserSpec {
  return {
    ...(typeof user.name === "string" ? { name: user.name } : {}),
    ...(typeof user.userId === "number" && Number.isInteger(user.userId) && user.userId > 0 ? { userId: user.userId } : {}),
    ...(typeof user.username === "string" ? { username: user.username } : {}),
    ...(typeof user.email === "string" ? { email: user.email } : {}),
    ...(typeof user.role === "string" ? { role: user.role } : {}),
    ...(typeof user.displayName === "string" ? { displayName: user.displayName } : {}),
    ...(typeof user.password === "string" ? { password: user.password } : {}),
    ...(isRecord(user.metadata) ? { metadata: user.metadata } : {}),
  }
}

function recipeInputRecord(runtimeSpec: RuntimeCreateSpec): Record<string, unknown> {
  const recipe = isRecord(runtimeSpec.metadata?.recipe) ? runtimeSpec.metadata.recipe : undefined
  const task = isRecord(runtimeSpec.metadata?.task) ? runtimeSpec.metadata.task : undefined
  const inputs = isRecord(recipe?.inputs) ? recipe.inputs : isRecord(task?.inputs) ? task.inputs : {}
  return inputs
}
