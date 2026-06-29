export const WORDPRESS_RUNTIME_DISCOVERY_SCHEMA = "wp-codebox/wordpress-runtime-discovery/v1" as const
export const WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA = "wp-codebox/wordpress-rest-route-inventory/v1" as const
export const WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA = "wp-codebox/wordpress-admin-page-inventory/v1" as const
export const WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA = "wp-codebox/wordpress-admin-action-inventory/v1" as const
export const WORDPRESS_DATABASE_INVENTORY_SCHEMA = "wp-codebox/wordpress-db-inventory/v1" as const
export const WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA = "wp-codebox/wordpress-frontend-url-inventory/v1" as const
export const WORDPRESS_EXECUTION_SURFACES_SCHEMA = "wp-codebox/wordpress-execution-surfaces/v1" as const
export const WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA = "wp-codebox/wordpress-execution-action-result/v1" as const

export type WordPressRuntimeInventoryCommand =
  | "wordpress.rest-route-inventory"
  | "wordpress.inventory-rest-routes"
  | "wordpress.admin-page-inventory"
  | "wordpress.admin-action-inventory"
  | "wordpress.inventory-database"
  | "wordpress.frontend-url-inventory"
  | "wordpress.execution-surfaces"

export type WordPressRuntimeDiscoverySurface = "rest" | "admin" | "database" | "frontend" | "blocks" | "auth" | "execution"

export interface WordPressRuntimeDiscoveryResult {
  schema: typeof WORDPRESS_RUNTIME_DISCOVERY_SCHEMA
  command: "wordpress.runtime-discovery"
  status: "ok"
  surfaces: WordPressRuntimeDiscoverySurface[]
  rest?: WordPressRestRouteDiscovery
  admin?: WordPressAdminPageDiscovery
  database?: WordPressDatabaseSchemaDiscovery
  frontend?: WordPressFrontendRouteDiscovery
  blocks?: WordPressBlockEditorTargetDiscovery
  auth?: WordPressRuntimeAuthDiscovery
  execution?: WordPressExecutionSurfaceDiscovery
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressRuntimeDiscoveryDiagnostic {
  surface: WordPressRuntimeDiscoverySurface
  code: string
  message: string
  data?: unknown
}

export interface WordPressRestRouteDiscovery {
  schema: "wp-codebox/wordpress-rest-route-discovery/v1"
  routes: WordPressRestRouteDescriptor[]
  namespaces: string[]
}

export interface WordPressRestRouteInventory {
  schema: typeof WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA
  command: "wordpress.rest-route-inventory" | "wordpress.inventory-rest-routes"
  status: "ok" | "unsupported"
  routes: WordPressRestRouteDescriptor[]
  namespaces: string[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressRestRouteDescriptor {
  route: string
  namespace: string
  methods: string[]
  argNames: string[]
  endpoints?: WordPressRestRouteEndpointDescriptor[]
  schema?: WordPressRestRouteSchemaDescriptor
}

export interface WordPressRestRouteEndpointDescriptor {
  methods: string[]
  permission: WordPressRestRoutePermissionDescriptor
  args: WordPressRestRouteArgDescriptor[]
}

export interface WordPressRestRoutePermissionDescriptor {
  mode: "public" | "callback" | "none"
  callbackType?: string
}

export interface WordPressRestRouteArgDescriptor {
  name: string
  required: boolean
  type?: string | string[]
  format?: string
  enum?: Array<string | number | boolean | null>
  description?: string
  defaultPresent?: boolean
  validateCallback?: boolean
  sanitizeCallback?: boolean
}

export interface WordPressRestRouteSchemaDescriptor {
  title?: string
  type?: string | string[]
  properties?: string[]
}

export interface WordPressAdminPageDiscovery {
  schema: "wp-codebox/wordpress-admin-page-discovery/v1"
  adminUrl: string
  menuLoaded: boolean
  user?: WordPressAdminDiscoveryUserContext
  pages: WordPressAdminPageDescriptor[]
}

export interface WordPressAdminPageInventory {
  schema: typeof WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA
  command: "wordpress.admin-page-inventory"
  status: "ok" | "unsupported"
  adminUrl: string
  menuLoaded: boolean
  user?: WordPressAdminDiscoveryUserContext
  pages: WordPressAdminPageDescriptor[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressAdminActionInventory {
  schema: typeof WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA
  command: "wordpress.admin-action-inventory"
  status: "ok" | "unsupported"
  adminUrl: string
  menuLoaded: boolean
  user?: WordPressAdminDiscoveryUserContext
  pages: WordPressAdminActionPageDescriptor[]
  actions: WordPressAdminPageInteractionDescriptor[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
  redaction: { samplePayloadValues: "redacted"; nonceValues: "redacted" }
}

export interface WordPressAdminActionPageDescriptor extends WordPressAdminPageDescriptor {
  forms: WordPressAdminPageInteractionDescriptor[]
  actions: WordPressAdminPageInteractionDescriptor[]
}

export interface WordPressAdminDiscoveryUserContext {
  isLoggedIn: boolean
  id: number
  roles: string[]
}

export interface WordPressAdminPageDescriptor {
  menuSlug: string
  pageTitle: string
  menuTitle: string
  capability: string
  canAccess?: boolean | null
  canonicalUrl?: string
  parentSlug?: string
  forms?: WordPressAdminPageInteractionDescriptor[]
  actions?: WordPressAdminPageInteractionDescriptor[]
}

export interface WordPressAdminPageInteractionDescriptor {
  id?: string
  kind?: "form" | "action" | "interaction" | string
  method?: string
  selector?: string
  action?: string
  actionUrl?: string
  actionFamily?: "admin-post" | "admin-ajax" | "admin-page" | "external" | string
  submitButtons?: WordPressAdminSubmitButtonDescriptor[]
  inputs?: WordPressAdminFieldDescriptor[]
  samplePayload?: Record<string, unknown>
  bulkActions?: WordPressAdminBulkActionDescriptor[]
  fields?: Record<string, unknown>
  capability?: string
  nonceAction?: string
  nonce_action?: string
  nonceField?: string
  nonce_field?: string
  safety?: Record<string, unknown>
}

export interface WordPressAdminFieldDescriptor {
  name: string
  tag: "input" | "select" | "textarea" | string
  type?: string
  valuePresent?: boolean
  valueRedacted?: boolean
  options?: string[]
}

export interface WordPressAdminSubmitButtonDescriptor {
  name?: string
  valuePresent?: boolean
  valueRedacted?: boolean
  label?: string
}

export interface WordPressAdminBulkActionDescriptor {
  controlName: string
  actions: string[]
}

export interface WordPressDatabaseSchemaDiscovery {
  schema: "wp-codebox/wordpress-db-schema-discovery/v1"
  prefix: string
  tables: WordPressDatabaseTableDescriptor[]
}

export interface WordPressDatabaseInventory {
  schema: typeof WORDPRESS_DATABASE_INVENTORY_SCHEMA
  command: "wordpress.inventory-database"
  status: "ok" | "unsupported"
  prefix: string
  tables: WordPressDatabaseTableDescriptor[]
  totals: WordPressDatabaseInventoryTotals
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressDatabaseInventoryTotals {
  tableCount: number
  rowCount: number
  columnCount: number
  indexCount: number
  dataBytes: number
  indexBytes: number
  totalBytes: number
}

export interface WordPressDatabaseTableDescriptor {
  name: string
  baseName: string
  classification: "core" | "prefixed" | "external"
  writable?: boolean | null
  primaryKeyColumns?: string[]
  primary_key_columns?: string[]
  engine?: string
  rowCount?: number
  dataBytes?: number
  indexBytes?: number
  totalBytes?: number
  columns: WordPressDatabaseColumnDescriptor[]
  indexes?: WordPressDatabaseIndexDescriptor[]
  status?: WordPressDatabaseTableStatus | null
}

export interface WordPressDatabaseColumnDescriptor {
  name: string
  type: string
  nullable: boolean
  key: string
  default: string | null
  extra: string
}

export interface WordPressDatabaseIndexDescriptor {
  name: string
  column: string
  unique: boolean
  sequence: number | null
}

export interface WordPressDatabaseTableStatus {
  engine: string
  rows: number | null
  collation: string
  dataBytes?: number
  indexBytes?: number
  totalBytes?: number
}

export interface WordPressFrontendRouteDiscovery {
  schema: "wp-codebox/wordpress-frontend-route-discovery/v1"
  homeUrl: string
  permalinkStructure: string
  rewriteRules: WordPressRewriteRuleDescriptor[]
  publicQueryVars: string[]
}

export interface WordPressFrontendUrlInventory {
  schema: typeof WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA
  command: "wordpress.frontend-url-inventory"
  status: "ok" | "unsupported"
  homeUrl: string
  permalinkStructure: string
  urls: WordPressFrontendUrlDescriptor[]
  rewriteRules: WordPressRewriteRuleDescriptor[]
  publicQueryVars: string[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressFrontendUrlDescriptor {
  url: string
  source: "home" | "rewrite-rule"
  pattern?: string
  query?: string
}

export interface WordPressExecutionSurfaceDiscovery {
  schema: typeof WORDPRESS_EXECUTION_SURFACES_SCHEMA
  command: "wordpress.execution-surfaces"
  status: "ok" | "unsupported"
  surfaces: WordPressExecutionSurfaceDescriptor[]
  unsupported: WordPressExecutionUnsupportedCapability[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export type WordPressExecutionSurfaceKind = "wp-cli" | "hook" | "cron"

export interface WordPressExecutionSurfaceDescriptor {
  kind: WordPressExecutionSurfaceKind
  command: "wordpress.invoke-wp-cli" | "wordpress.invoke-hook" | "wordpress.invoke-cron-event"
  supported: boolean
  executable: boolean
  discovery: WordPressExecutionCapabilitySupport
  counting: WordPressExecutionCapabilitySupport
  invocation: WordPressExecutionInvocationSupport
  scheduling?: WordPressExecutionCapabilitySupport
  safety: WordPressExecutionSafetyBoundary
}

export interface WordPressExecutionCapabilitySupport {
  supported: boolean
  reason?: string
}

export interface WordPressExecutionInvocationSupport extends WordPressExecutionCapabilitySupport {
  argumentEncoding: "argv-json" | "args-json" | "command-string"
  resultSchema: typeof WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA
}

export interface WordPressExecutionSafetyBoundary {
  mutates: "declared-by-caller"
  requiresMutationDeclaration: boolean
  capabilityField: "capability"
  destructiveBoundaryField: "destructive-boundary"
  defaultDestructiveBoundary: "disposable-runtime"
  rollbackRequired: false
}

export interface WordPressExecutionUnsupportedCapability {
  surface: WordPressExecutionSurfaceKind
  capability: "discovery" | "counting" | "scheduling"
  reason: string
}

export interface WordPressExecutionActionResult {
  schema: typeof WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA
  command: "wordpress.invoke-wp-cli" | "wordpress.invoke-hook" | "wordpress.invoke-cron-event"
  status: "ok" | "unsupported" | "error"
  target: Record<string, unknown>
  safety: WordPressExecutionSafetyBoundary & {
    mutates: boolean
    capability?: string
    destructiveBoundary: string
  }
  result: Record<string, unknown>
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressRewriteRuleDescriptor {
  pattern: string
  query: string
}

export interface WordPressBlockEditorTargetDiscovery {
  schema: "wp-codebox/wordpress-block-editor-target-discovery/v1"
  blocks: WordPressBlockTypeDescriptor[]
  editorPostTypes: WordPressEditorPostTypeDescriptor[]
}

export interface WordPressBlockTypeDescriptor {
  name: string
  title: string
  category: string
  supportsInserter: boolean
  attributes: WordPressBlockAttributeDescriptor[]
  exampleAttributes?: Record<string, unknown>
}

export interface WordPressBlockAttributeDescriptor {
  name: string
  type?: string | string[]
  enum?: Array<string | number | boolean | null>
  defaultPresent?: boolean
  default?: unknown
}

export interface WordPressEditorPostTypeDescriptor {
  name: string
  label: string
  restBase: string
  editorUrl: string
}

export interface WordPressRuntimeAuthDiscovery {
  schema: "wp-codebox/wordpress-auth-discovery/v1"
  actions: WordPressRuntimeAuthActionDescriptor[]
  capabilities: {
    fixtureUsers: boolean
    userSessions: boolean
    browserStorageStateArtifacts: boolean
    restNonce: boolean
    actionNonce: boolean
  }
  resultRedaction: {
    cookies: "artifact-ref-only"
    nonces: "redacted-in-summary"
  }
}

export interface WordPressRuntimeAuthActionDescriptor {
  command: "wordpress.session" | "wordpress.nonce" | "wordpress.action-auth"
  purpose: string
  acceptedSelectors: string[]
  artifactKinds: string[]
  redactionRequired: boolean
}
