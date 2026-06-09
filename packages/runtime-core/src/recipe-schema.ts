export type WorkspaceRecipeJsonSchema = Record<string, unknown>

export interface WorkspaceRecipeJsonSchemaOptions {
  recipeCommandIds?: readonly string[]
}

export function createWorkspaceRecipeJsonSchema(options: WorkspaceRecipeJsonSchemaOptions = {}): WorkspaceRecipeJsonSchema {
  const commandSchema = options.recipeCommandIds && options.recipeCommandIds.length > 0
    ? { enum: [...options.recipeCommandIds] }
    : { type: "string" }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "wp-codebox/workspace-recipe/v1",
    title: "WP Codebox workspace recipe",
    type: "object",
    additionalProperties: false,
    required: ["schema", "workflow"],
    properties: {
      schema: { const: "wp-codebox/workspace-recipe/v1" },
      distribution: { $ref: "#/$defs/distribution" },
      runtime: {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: { const: "wordpress-playground" },
          name: { type: "string" },
          wp: { type: "string" },
          phpVersion: {
            type: "string",
            pattern: "^[0-9]+\\.[0-9]+$",
            description: "PHP runtime version passed to WordPress Playground, for example 8.3 or 8.4.",
          },
          wordpressInstallMode: {
            enum: ["install-from-existing-files", "install-from-existing-files-if-needed", "do-not-attempt-installing"],
            description: "Controls how Playground prepares a mounted WordPress directory. Use do-not-attempt-installing for custom distributions that own their own boot/readiness probes.",
          },
          blueprint: { type: "object" },
          preview: { $ref: "#/$defs/runtimePreview" },
          assets: { $ref: "#/$defs/runtimeAssets" },
          backendPackage: { $ref: "#/$defs/runtimeBackendPackage" },
          stack: { $ref: "#/$defs/runtimeStack" },
          overlays: {
            type: "array",
            description: "Typed runtime overlays prepared by WP Codebox before mounting into Playground.",
            items: { $ref: "#/$defs/runtimeOverlay" },
          },
        },
      },
      inputs: {
        type: "object",
        additionalProperties: false,
        properties: {
          mounts: {
            type: "array",
            items: { $ref: "#/$defs/mount" },
          },
          workspaces: {
            type: "array",
            items: { $ref: "#/$defs/workspace" },
          },
          extra_plugins: {
            type: "array",
            items: { $ref: "#/$defs/extraPlugin" },
          },
          dependency_overlays: {
            type: "array",
            description: "Typed local dependency overlays mounted into a consumer plugin before setup, activation, and workflow steps.",
            items: { $ref: "#/$defs/dependencyOverlay" },
          },
          secretEnv: {
            type: "array",
            items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
          },
          pluginRuntime: { $ref: "#/$defs/pluginRuntime" },
          fixtureDatabases: {
            type: "array",
            description: "Fixture database declarations imported into the sandbox with deterministic reset metadata. Sources are local recipe files; no production database access is implied.",
            items: { $ref: "#/$defs/fixtureDatabase" },
          },
          siteSeeds: {
            type: "array",
            description: "Explicit site/content seed declarations. Local JSON fixture seeds are imported into the sandbox before workflow steps. Parent-site declarations remain bounded, auditable metadata until export support lands.",
            items: { $ref: "#/$defs/siteSeed" },
          },
          stagedFiles: {
            type: "array",
            description: "Local recipe-owned files or directories copied into absolute sandbox paths before workflow steps execute.",
            items: { $ref: "#/$defs/stagedFile" },
          },
          agent_bundles: {
            type: "array",
            description: "Runtime agent bundles to import into the sandbox before invoking the selected runtime agent.",
            items: { $ref: "#/$defs/agentBundle" },
          },
          inherit: { $ref: "#/$defs/inheritanceRequest" },
          inheritance: { $ref: "#/$defs/inheritanceResolution" },
        },
      },
      workflow: {
        type: "object",
        additionalProperties: false,
        required: ["steps"],
        properties: {
          before: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
          steps: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/step" },
          },
          after: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
        },
      },
      artifacts: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string" },
          verify: { $ref: "#/$defs/artifactVerifier" },
          workspacePolicy: { $ref: "#/$defs/workspacePolicyArtifact" },
          paths: {
            type: "array",
            description: "Sandbox artifact paths declared by the recipe for structured post-run collection.",
            items: { $ref: "#/$defs/declaredArtifact" },
          },
        },
      },
      probes: {
        type: "array",
        description: "Recipe-defined post-startup probes executed after workflow steps and before artifact finalization.",
        items: { $ref: "#/$defs/recipeProbe" },
      },
    },
    $defs: {
      artifactVerifier: {
        oneOf: [
          { type: "boolean" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              strict: { type: "boolean" },
            },
          },
        ],
      },
      workspacePolicyArtifact: {
        oneOf: [
          { type: "boolean" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              strict: { type: "boolean" },
              writableRoots: { type: "array", items: { type: "string" } },
              hiddenPaths: { type: "array", items: { type: "string" } },
              gitBacked: { type: "boolean" },
            },
          },
        ],
      },
      metadata: {
        type: "object",
        additionalProperties: true,
      },
      distribution: {
        type: "object",
        additionalProperties: false,
        required: ["name", "wordpress"],
        description: "Generic external WordPress distribution declaration. Distribution-specific semantics live in recipe packs; WP Codebox only plans and validates the substrate.",
        properties: {
          name: { type: "string" },
          sourceMounts: {
            type: "array",
            items: { $ref: "#/$defs/distributionSourceMount" },
          },
          wordpress: { $ref: "#/$defs/distributionWordPress" },
          env: { $ref: "#/$defs/distributionScalarMap" },
          constants: { $ref: "#/$defs/distributionScalarMap" },
          serviceFakes: {
            type: "array",
            items: { $ref: "#/$defs/distributionServiceFake" },
          },
          routeAliases: {
            type: "array",
            items: { $ref: "#/$defs/distributionRouteAlias" },
          },
          startupProbes: {
            type: "array",
            items: { $ref: "#/$defs/distributionStartupProbe" },
          },
          artifacts: {
            type: "array",
            items: { $ref: "#/$defs/distributionArtifact" },
          },
          safety: { $ref: "#/$defs/distributionSafety" },
        },
      },
      distributionScalarMap: {
        type: "object",
        additionalProperties: {
          type: ["string", "number", "boolean", "null"],
        },
      },
      distributionSourceMount: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          type: { enum: ["directory", "file"] },
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
          mode: { enum: ["readonly", "readwrite"] },
          metadata: { $ref: "#/$defs/metadata" },
          role: { type: "string" },
          ref: { type: "string" },
        },
      },
      distributionWordPress: {
        type: "object",
        additionalProperties: false,
        required: ["root"],
        properties: {
          root: { type: "string", pattern: "^/" },
          bootstrap: { type: "string" },
          config: { type: "string" },
          bootstrapFile: { type: "string" },
        },
      },
      distributionServiceFake: {
        type: "object",
        additionalProperties: false,
        required: ["name", "source"],
        properties: {
          name: { type: "string" },
          source: { type: "string" },
          load: { enum: ["pre-bootstrap", "mu-plugin", "manual"] },
          sideEffectsArtifact: { type: "string" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      distributionRouteAlias: {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          name: { type: "string" },
          host: { type: "string" },
          path: { type: "string", pattern: "^/" },
          target: { type: "string" },
          targetType: { type: "string" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      distributionStartupProbe: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type"],
        properties: {
          name: { type: "string" },
          type: { enum: ["http", "browser", "wp-cli", "php"] },
          url: { type: "string" },
          command: { type: "string" },
          code: { type: "string" },
          expectStatus: { type: "integer", minimum: 100, maximum: 599 },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      distributionArtifact: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string" },
          kind: { type: "string" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      distributionSafety: {
        type: "object",
        additionalProperties: false,
        properties: {
          network: { enum: ["deny", "declared"] },
          allowedHosts: { type: "array", items: { type: "string" } },
          secretEnv: { type: "array", items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" } },
        },
      },
      runtimePreview: {
        type: "object",
        additionalProperties: false,
        description: "Recipe-declared preview defaults. CLI preview flags override these values for a run.",
        properties: {
          publicUrl: {
            type: "string",
            description: "Public http/https preview URL used for metadata and relative browser-probe URL resolution.",
          },
          siteUrl: {
            type: "string",
            description: "Optional WordPress site URL passed to the sandbox. Defaults to publicUrl or the local preview URL.",
          },
          port: {
            type: "integer",
            minimum: 1,
            maximum: 65535,
            description: "Optional fixed local preview proxy port.",
          },
          bind: {
            type: "string",
            description: "Optional fixed-port preview proxy bind host or IP. Requires port.",
          },
        },
      },
      runtimeAssets: {
        type: "object",
        additionalProperties: false,
        description: "Pre-resolved runtime assets. Use local paths or URLs to make recipe startup deterministic without live release metadata lookups.",
        properties: {
          wordpressDirectory: {
            type: "string",
            description: "Local WordPress source directory mounted at /wordpress before Playground installs or boots WordPress. Use a disposable source snapshot because Playground may write setup files into the mounted tree.",
          },
          wordpressZip: {
            type: "string",
            description: "Local path or HTTP(S) URL for a WordPress release zip used to boot the Playground runtime.",
          },
        },
      },
      mount: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          type: { enum: ["directory", "file"] },
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
          mode: { enum: ["readonly", "readwrite"] },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      runtimeStack: {
        type: "object",
        additionalProperties: false,
        description: "Explicit runtime stack overlays mounted before recipe workspaces, plugins, and workflow steps. Use this to test alternate WordPress core or bundled dependency refs without consumer-specific shims.",
        properties: {
          mounts: {
            type: "array",
            items: { $ref: "#/$defs/mount" },
          },
        },
      },
      runtimeBackendPackage: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "source"],
        description: "Optional local Playground backend package or entrypoint used to boot the runtime. This selects the backend package itself and is separate from /wordpress filesystem overlays.",
        properties: {
          kind: { const: "playground" },
          source: { type: "string" },
          package: { type: "string" },
          entrypoint: { type: "string" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      runtimeOverlay: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "library", "source", "strategy"],
        properties: {
          kind: { const: "bundled-library" },
          library: { const: "php-ai-client" },
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
          strategy: { const: "wordpress-scoped-bundle" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      workspace: {
        type: "object",
        additionalProperties: false,
        required: ["seed"],
        properties: {
          target: { type: "string", pattern: "^/" },
          mode: { enum: ["readonly", "readwrite"] },
          sourceMode: { enum: ["repo-backed", "site-backed"] },
          seed: { $ref: "#/$defs/workspaceSeed" },
        },
      },
      workspaceSeed: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { enum: ["plugin_scaffold", "theme_scaffold", "directory"] },
          slug: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          name: { type: "string" },
          source: { type: "string" },
          excludePaths: { type: "array", items: { type: "string" } },
        },
      },
      extraPlugin: {
        type: "object",
        additionalProperties: false,
        required: ["source"],
        properties: {
          source: {
            type: "string",
            description: "Local plugin directory path, WordPress.org plugin zip URL, or generic HTTPS zip URL.",
          },
          slug: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          pluginFile: { type: "string" },
          activate: { type: "boolean" },
          loadAs: { enum: ["plugin", "mu-plugin"] },
          sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        },
      },
      dependencyOverlay: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "package", "source", "consumer"],
        properties: {
          kind: { const: "composer-package" },
          package: { type: "string", pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$" },
          source: { type: "string" },
          consumer: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      pluginRuntime: {
        type: "object",
        additionalProperties: false,
        description: "Generic runtime options for heavyweight plugin stacks. Consumers can tune PHP/WP config, run ordered setup hooks, and declare health probes without consumer-specific semantics.",
        properties: {
          label: { type: "string" },
          php: {
            type: "object",
            additionalProperties: false,
            properties: {
              memoryLimit: { type: "string", pattern: "^[0-9]+[KMG]?$" },
              maxExecutionTime: { type: "integer", minimum: 0, maximum: 3600 },
            },
          },
          wpConfigDefines: {
            type: "object",
            additionalProperties: {
              type: ["string", "number", "boolean", "null"],
            },
          },
          setup: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
          healthProbes: {
            type: "array",
            items: { $ref: "#/$defs/pluginRuntimeHealthProbe" },
          },
        },
      },
      agentBundle: {
        type: "object",
        additionalProperties: false,
        anyOf: [
          { required: ["source"] },
          { required: ["bundle"] },
        ],
        properties: {
          source: {
            type: "string",
            description: "Runtime agent bundle source: local directory, .zip, .json, or remote URL.",
          },
          bundle: {
            type: "object",
            description: "Inline runtime agent bundle JSON staged into the sandbox and imported through the runtime bundle importer.",
          },
          slug: { type: "string" },
          on_conflict: { enum: ["error", "skip", "upgrade"] },
          owner_id: { type: "integer", minimum: 1 },
          token_env: {
            type: "string",
            description: "Environment variable or PHP constant name used by the runtime bundle importer for private source resolution.",
          },
        },
      },
      pluginRuntimeHealthProbe: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          type: { enum: ["plugin-active", "php", "wp-cli"] },
          pluginFile: { type: "string" },
          code: { type: "string" },
          command: { type: "string" },
        },
      },
      fixtureDatabase: {
        type: "object",
        additionalProperties: false,
        required: ["name", "version", "source"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          version: { type: "string", minLength: 1 },
          source: { type: "string" },
          format: { const: "sql" },
          reset: {
            type: "object",
            additionalProperties: false,
            properties: {
              strategy: { enum: ["none", "truncate-tables"] },
              tables: { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9_$]+$" }, maxItems: 100 },
            },
          },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      recipeProbe: {
        type: "object",
        additionalProperties: false,
        required: ["name", "step"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          step: { $ref: "#/$defs/step" },
          expectJson: { type: "boolean" },
          allowFailure: { type: "boolean" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      declaredArtifact: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          path: { type: "string", pattern: "^/" },
          required: { type: "boolean" },
          parseJson: { type: "boolean" },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      siteSeed: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "scopes"],
        properties: {
          type: { enum: ["fixture", "parent_site"] },
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          source: { type: "string", description: "Fixture file path. Not allowed for parent_site dry-run declarations." },
          format: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          scopes: {
            type: "object",
            additionalProperties: false,
            properties: {
              posts: { $ref: "#/$defs/siteSeedScope" },
              terms: { $ref: "#/$defs/siteSeedScope" },
              options: { $ref: "#/$defs/siteSeedScope" },
              users: { $ref: "#/$defs/siteSeedScope" },
              media: { $ref: "#/$defs/siteSeedScope" },
              activePlugins: { type: "boolean" },
              activeTheme: { type: "boolean" },
            },
          },
        },
      },
      siteSeedScope: {
        type: "object",
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 100 },
          slugs: { type: "array", items: { type: "string" }, maxItems: 100 },
          names: { type: "array", items: { type: "string" }, maxItems: 100 },
          postTypes: { type: "array", items: { type: "string" }, maxItems: 25 },
          taxonomies: { type: "array", items: { type: "string" }, maxItems: 25 },
          roles: { type: "array", items: { type: "string" }, maxItems: 25 },
          statuses: { type: "array", items: { type: "string" }, maxItems: 25 },
          includeFiles: { type: "boolean" },
          anonymize: { type: "boolean" },
          maxRecords: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      stagedFile: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
        },
      },
      step: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: commandSchema,
          args: {
            type: "array",
            items: { type: "string" },
          },
          allowFailure: { type: "boolean" },
          advisory: { type: "boolean" },
        },
      },
      inheritanceRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectors: { type: "array", items: { type: "string" } },
          settings: { type: "array", items: { type: "string" } },
        },
      },
      inheritanceResolution: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectors: { type: "array", items: { $ref: "#/$defs/inheritanceConnector" } },
          settings: { type: "array", items: { $ref: "#/$defs/inheritanceSetting" } },
        },
      },
      inheritanceConnector: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          providerPluginPaths: { type: "array", items: { type: "string" } },
          secretEnv: { type: "array", items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" } },
          credentials: { $ref: "#/$defs/connectorCredentialEnvelope" },
        },
      },
      connectorCredentialEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["schema", "connector", "scope", "status", "secrets"],
        properties: {
          schema: { const: "wp-codebox/connector-credentials/v1" },
          connector: { type: "string" },
          scope: { const: "connector" },
          status: { enum: ["available", "missing", "denied"] },
          reason: { type: "string" },
          secrets: { type: "array", items: { $ref: "#/$defs/connectorCredentialSecret" } },
        },
      },
      connectorCredentialSecret: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
          status: { enum: ["available", "missing", "denied"] },
          scope: { type: "string" },
          source: { type: "string" },
          reason: { type: "string" },
        },
      },
      inheritanceSetting: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { type: "string" },
          scope: { type: "string" },
        },
      },
    },
  }
}
