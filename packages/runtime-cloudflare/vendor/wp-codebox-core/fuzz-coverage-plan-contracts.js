import { stripUndefined } from "./object-utils.js";
export const FUZZ_COVERAGE_PLAN_SCHEMA = "wp-codebox/fuzz-coverage-plan/v1";
export function fuzzCoveragePlanContract(input) {
    const discovered = input.discovered ?? [];
    const generated = input.generated ?? [];
    const executable = input.executable ?? [];
    const executed = input.executed ?? [];
    const skipped = input.skipped ?? [];
    const untested = input.untested ?? [];
    const allItems = [...discovered, ...generated, ...executable, ...executed, ...skipped, ...untested];
    return stripUndefined({
        schema: FUZZ_COVERAGE_PLAN_SCHEMA,
        id: input.id,
        version: input.version,
        discovered,
        generated,
        executable,
        executed,
        skipped,
        untested,
        parameterGenerationHooks: input.parameterGenerationHooks?.length ? input.parameterGenerationHooks : undefined,
        summary: {
            discovered: discovered.length,
            generated: generated.length,
            executable: executable.length,
            executed: executed.length,
            skipped: skipped.length,
            untested: untested.length,
            caseIds: uniqueStrings(allItems.map((item) => item.id)),
            targetIds: uniqueStrings(allItems.map((item) => item.target?.id ?? item.target?.entrypoint ?? item.target?.kind)),
        },
        metadata: input.metadata,
    });
}
function uniqueStrings(values) {
    return [...new Set(values.filter((value) => Boolean(value)))];
}
//# sourceMappingURL=fuzz-coverage-plan-contracts.js.map