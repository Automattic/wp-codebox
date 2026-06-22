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
$sandbox_fixture_user = json_decode( ${JSON.stringify(JSON.stringify(user))}, true );
if ( ! is_array( $sandbox_fixture_user ) ) {
    $sandbox_fixture_user = array();
}
$sandbox_requested_user_id = isset( $sandbox_fixture_user['userId'] ) ? (int) $sandbox_fixture_user['userId'] : 0;
$sandbox_username = isset( $sandbox_fixture_user['username'] ) && is_string( $sandbox_fixture_user['username'] ) && '' !== trim( $sandbox_fixture_user['username'] ) ? sanitize_user( $sandbox_fixture_user['username'], true ) : sanitize_user( (string) ( $sandbox_fixture_user['name'] ?? 'sandbox_fixture_user' ), true );
if ( '' === $sandbox_username ) {
    throw new RuntimeException( 'Fixture user username is invalid.' );
}
$sandbox_role = isset( $sandbox_fixture_user['role'] ) && is_string( $sandbox_fixture_user['role'] ) && '' !== trim( $sandbox_fixture_user['role'] ) ? sanitize_key( $sandbox_fixture_user['role'] ) : 'administrator';
if ( ! get_role( $sandbox_role ) ) {
    throw new RuntimeException( 'Fixture user role does not exist: ' . $sandbox_role );
}
$sandbox_email = isset( $sandbox_fixture_user['email'] ) && is_string( $sandbox_fixture_user['email'] ) && is_email( $sandbox_fixture_user['email'] ) ? $sandbox_fixture_user['email'] : $sandbox_username . '@example.test';
$sandbox_display_name = isset( $sandbox_fixture_user['displayName'] ) && is_string( $sandbox_fixture_user['displayName'] ) && '' !== trim( $sandbox_fixture_user['displayName'] ) ? $sandbox_fixture_user['displayName'] : $sandbox_username;
$sandbox_password = isset( $sandbox_fixture_user['password'] ) && is_string( $sandbox_fixture_user['password'] ) && '' !== $sandbox_fixture_user['password'] ? $sandbox_fixture_user['password'] : wp_generate_password( 32, true, true );
$sandbox_user = $sandbox_requested_user_id > 0 ? get_user_by( 'id', $sandbox_requested_user_id ) : get_user_by( 'login', $sandbox_username );
if ( ! $sandbox_user && $sandbox_requested_user_id <= 0 ) {
    $sandbox_user_id = wp_insert_user(
        array(
            'user_login'   => $sandbox_username,
            'user_email'   => $sandbox_email,
            'user_pass'    => $sandbox_password,
            'display_name' => $sandbox_display_name,
            'role'         => $sandbox_role,
        )
    );
    if ( is_wp_error( $sandbox_user_id ) ) {
        throw new RuntimeException( 'Fixture user creation failed: ' . $sandbox_user_id->get_error_message() );
    }
    $sandbox_user = get_user_by( 'id', (int) $sandbox_user_id );
}
if ( ! $sandbox_user ) {
    throw new RuntimeException( 'Fixture user could not be resolved.' );
}
$sandbox_user_id = (int) $sandbox_user->ID;
$sandbox_wp_user = new WP_User( $sandbox_user_id );
if ( ! in_array( $sandbox_role, (array) $sandbox_wp_user->roles, true ) ) {
    $sandbox_wp_user->add_role( $sandbox_role );
}
wp_set_current_user( $sandbox_user_id );`
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
