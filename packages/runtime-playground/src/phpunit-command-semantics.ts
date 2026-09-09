import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { argValue, booleanArg } from "./command-args.js"

export interface PhpunitExecutionSemantics {
  bootstrapMode: string
  databaseType: "sqlite" | "mysql" | "mdi-native"
  externalDatabase: boolean
  multisite: boolean
}

export function phpunitExecutionSemantics(args: string[], runtimeSpec: Pick<RuntimeCreateSpec, "environment" | "runtimeEnv">): PhpunitExecutionSemantics {
  const bootstrapMode = argValue(args, "bootstrap-mode")?.trim() || "managed"
  const declaredDatabaseType = argValue(args, "database-type")?.trim()
  if (declaredDatabaseType && declaredDatabaseType !== "sqlite" && declaredDatabaseType !== "mysql" && declaredDatabaseType !== "mdi-native") {
    throw new Error(`wordpress.phpunit does not support database-type=${declaredDatabaseType}; supported backends are sqlite, mysql, and mdi-native`)
  }
  const externalDatabase = runtimeSpec.environment?.databaseSetup === "external"
  const databaseType: "sqlite" | "mysql" | "mdi-native" = declaredDatabaseType === "mysql" || declaredDatabaseType === "sqlite" || declaredDatabaseType === "mdi-native"
    ? declaredDatabaseType
    : externalDatabase && runtimeSpec.runtimeEnv?.DB_HOST ? "mysql" : "sqlite"

  return { bootstrapMode, databaseType, externalDatabase, multisite: booleanArg(args, "multisite") }
}

export function requiresManagedMultisitePreinstall(args: string[], runtimeSpec: Pick<RuntimeCreateSpec, "environment" | "runtimeEnv">): boolean {
  const semantics = phpunitExecutionSemantics(args, runtimeSpec)
  return semantics.bootstrapMode === "managed" && semantics.multisite && (
    (semantics.databaseType === "mysql" && semantics.externalDatabase)
    || semantics.databaseType === "mdi-native"
  )
}
