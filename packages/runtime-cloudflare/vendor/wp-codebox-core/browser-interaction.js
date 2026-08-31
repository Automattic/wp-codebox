import { isPlainObject } from "./object-utils.js";
export const BROWSER_INTERACTION_SCRIPT_SCHEMA = "wp-codebox/browser-interaction-script/v1";
export const BROWSER_TOOL_VERIFIER_RESULT_SCHEMA = "wp-codebox/browser-tool-verifier-result/v1";
/**
 * Backend-agnostic browser interaction step contract (issue #310).
 *
 * runtime-core declares the schema; a runtime backend (e.g. runtime-playground)
 * implements the executor that maps each step onto its driver. Steps are a thin,
 * stable mapping over locator-style actions — not a test-runner DSL.
 *
 * Layer purity: this type knows nothing about Playwright or Playground. It is the
 * shared contract any backend can satisfy.
 */
export const BROWSER_INTERACTION_STEP_KINDS = [
    "navigate",
    "click",
    "fill",
    "type",
    "press",
    "drag",
    "hover",
    "select",
    "waitFor",
    "evaluate",
    "expect",
    "assertObservation",
    "screenshot",
    "capture",
    "callTool",
];
export const BROWSER_RANDOM_WALK_SCHEMA = "wp-codebox/browser-random-walk/v1";
export const BROWSER_ACTION_CORPUS_SCHEMA = "wp-codebox/browser-action-corpus/v1";
export const BROWSER_ACTION_CORPUS_ARTIFACT_SCHEMA = "wp-codebox/browser-action-corpus-artifact/v1";
export const BROWSER_RANDOM_WALK_CONTEXTS = ["browser", "admin", "editor"];
export const BROWSER_RANDOM_WALK_ACTION_FAMILIES = ["click", "fill", "press", "select", "navigate", "capture"];
/** Locator/element state checked by an `expect` step. */
export const BROWSER_INTERACTION_EXPECT_STATES = ["visible", "hidden", "attached", "detached", "enabled", "disabled", "checked", "unchecked", "editable"];
export const BROWSER_ACTION_CORPUS_GENERATOR_KINDS = ["text", "email", "url", "search", "number", "password", "textarea", "checkbox", "radio", "select"];
function isBrowserInteractionDragTarget(value) {
    if (!isPlainObject(value))
        return false;
    if (typeof value.selector === "string" && value.selector.length > 0)
        return true;
    return typeof value.x === "number" && typeof value.y === "number";
}
export function browserToolVerifierInputSummary(input) {
    if (input === null)
        return { type: "null" };
    if (Array.isArray(input))
        return { type: "array", itemCount: input.length };
    if (typeof input === "object")
        return { type: "object", keys: Object.keys(input).sort() };
    return { type: inputType(input) };
}
function inputType(input) {
    if (typeof input === "string")
        return "string";
    if (typeof input === "number")
        return "number";
    return "boolean";
}
/**
 * Validate an ordered browser interaction script against the backend-agnostic
 * step contract. Returns normalized steps plus per-index issues; backends call
 * this before executing so every backend enforces the same contract.
 */
export function validateBrowserInteractionScript(input) {
    const issues = [];
    const steps = [];
    if (!Array.isArray(input)) {
        return { valid: false, steps, issues: [{ index: -1, message: "browser interaction script must be a JSON array of steps" }] };
    }
    input.forEach((raw, index) => {
        if (!isPlainObject(raw)) {
            issues.push({ index, message: "step must be an object" });
            return;
        }
        const kind = raw.kind;
        if (typeof kind !== "string" || !BROWSER_INTERACTION_STEP_KINDS.includes(kind)) {
            issues.push({ index, message: `step kind must be one of ${BROWSER_INTERACTION_STEP_KINDS.join(", ")}` });
            return;
        }
        const step = raw;
        const hasSelector = typeof step.selector === "string" && step.selector.length > 0;
        const hasText = typeof step.text === "string" && step.text.length > 0;
        switch (kind) {
            case "navigate":
                if (typeof step.url !== "string" || step.url.trim().length === 0) {
                    issues.push({ index, message: "navigate step requires url" });
                }
                break;
            case "click":
            case "hover":
                if (!hasSelector && !hasText) {
                    issues.push({ index, message: `${kind} step requires selector or text` });
                }
                break;
            case "fill":
            case "type":
                if (!hasSelector)
                    issues.push({ index, message: `${kind} step requires selector` });
                if (typeof step.value !== "string")
                    issues.push({ index, message: `${kind} step requires value` });
                break;
            case "press":
                if (typeof step.key !== "string" || step.key.length === 0) {
                    issues.push({ index, message: "press step requires key" });
                }
                break;
            case "drag":
                if (typeof step.from !== "string" || step.from.length === 0) {
                    issues.push({ index, message: "drag step requires from selector" });
                }
                if (!isBrowserInteractionDragTarget(step.to)) {
                    issues.push({ index, message: "drag step requires to as { selector } or { x, y }" });
                }
                break;
            case "select":
                if (!hasSelector)
                    issues.push({ index, message: "select step requires selector" });
                if (typeof step.value !== "string" && !Array.isArray(step.values)) {
                    issues.push({ index, message: "select step requires value or values" });
                }
                break;
            case "waitFor":
                if (!hasSelector && typeof step.waitFor !== "string") {
                    issues.push({ index, message: "waitFor step requires selector or waitFor condition" });
                }
                break;
            case "evaluate":
                if (typeof step.expression !== "string" || step.expression.trim().length === 0) {
                    issues.push({ index, message: "evaluate step requires expression" });
                }
                break;
            case "expect":
                if (!hasSelector)
                    issues.push({ index, message: "expect step requires selector" });
                if (step.state !== undefined && !BROWSER_INTERACTION_EXPECT_STATES.includes(step.state)) {
                    issues.push({ index, message: `expect step state must be one of ${BROWSER_INTERACTION_EXPECT_STATES.join(", ")}` });
                }
                break;
            case "assertObservation":
                if (typeof step.assertion !== "string" || step.assertion.trim().length === 0) {
                    issues.push({ index, message: "assertObservation step requires assertion" });
                }
                else if (!isBrowserInteractionObservationAssertion(step.assertion)) {
                    issues.push({ index, message: "assertObservation supports no-console-errors, no-page-errors, request-count-by-host:<host><op><number>, and request-count-by-type:<type><op><number>" });
                }
                break;
            case "screenshot":
            case "capture":
                break;
            case "callTool":
                if (typeof step.tool !== "string" || !/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/i.test(step.tool)) {
                    issues.push({ index, message: "callTool step requires tool as a stable canonical tool id such as client/search_docs" });
                }
                if (!Object.prototype.hasOwnProperty.call(step, "input")) {
                    issues.push({ index, message: "callTool step requires input" });
                }
                else if (!isJsonValue(step.input)) {
                    issues.push({ index, message: "callTool step input must be JSON-serializable" });
                }
                break;
        }
        steps.push(step);
    });
    return { valid: issues.length === 0, steps, issues };
}
/** True when an interaction script contains at least one policy-gated evaluate step. */
export function browserInteractionScriptUsesEvaluate(steps) {
    return steps.some((step) => step.kind === "evaluate");
}
function isBrowserInteractionObservationAssertion(raw) {
    const value = raw.trim();
    if (value === "no-console-errors" || value === "no-page-errors")
        return true;
    if (value.startsWith("request-count-by-host:"))
        return /^.+(>=|<=|==|!=|=|>|<)\s*\d+$/.test(value.slice("request-count-by-host:".length).trim());
    if (value.startsWith("request-count-by-type:"))
        return /^.+(>=|<=|==|!=|=|>|<)\s*\d+$/.test(value.slice("request-count-by-type:".length).trim());
    return false;
}
/** Exact caller-provided tool command names referenced by `callTool` steps. */
export function browserInteractionScriptToolCalls(steps) {
    return [...new Set(steps.filter((step) => step.kind === "callTool" && typeof step.tool === "string").map((step) => step.tool))].sort();
}
function isJsonValue(value) {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return Number.isFinite(value) || typeof value !== "number";
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (!isPlainObject(value)) {
        return false;
    }
    return Object.values(value).every(isJsonValue);
}
export function browserRandomWalkContract(input) {
    const context = normalizeBrowserRandomWalkContext(input.context);
    const seed = typeof input.seed === "string" && input.seed.length > 0 ? input.seed : "browser-random-walk";
    const maxSteps = normalizeBrowserRandomWalkMaxSteps(input.maxSteps ?? input.max_steps);
    const families = normalizeBrowserRandomWalkActionFamilies(input.actionFamilies ?? input.action_families);
    return {
        schema: BROWSER_RANDOM_WALK_SCHEMA,
        context,
        seed,
        maxSteps,
        actionFamilies: families,
        startUrl: typeof input.startUrl === "string" ? input.startUrl : typeof input.start_url === "string" ? input.start_url : undefined,
        resetPolicy: isPlainObject(input.resetPolicy) ? input.resetPolicy : isPlainObject(input.reset_policy) ? input.reset_policy : undefined,
        metadata: isPlainObject(input.metadata) ? input.metadata : undefined,
    };
}
export function planBrowserRandomWalk(input) {
    const contract = browserRandomWalkContract(input);
    const diagnostics = [];
    const steps = [];
    const startUrl = contract.startUrl ?? defaultBrowserRandomWalkStartUrl(contract.context);
    if (!startUrl) {
        diagnostics.push({ code: "browser_random_walk_start_url_required", message: `Random walk context ${contract.context} requires startUrl.` });
    }
    else {
        steps.push({ kind: "navigate", url: startUrl, waitFor: "load" });
    }
    const budget = Math.max(contract.maxSteps - steps.length, 0);
    for (let index = 0; index < budget; index += 1) {
        const family = pickDeterministic(contract.actionFamilies, `${contract.seed}:${index}`);
        const step = browserRandomWalkStep(family, contract, index);
        if (step)
            steps.push(step);
    }
    if (steps.length === 0) {
        diagnostics.push({ code: "browser_random_walk_no_executable_steps", message: "Random walk planning produced no executable browser interaction steps." });
    }
    return {
        schema: BROWSER_RANDOM_WALK_SCHEMA,
        status: diagnostics.length > 0 ? "unsupported" : "planned",
        context: contract.context,
        seed: contract.seed,
        maxSteps: contract.maxSteps,
        actionFamilies: contract.actionFamilies,
        steps,
        replay: {
            schema: BROWSER_RANDOM_WALK_SCHEMA,
            seed: contract.seed,
            maxSteps: contract.maxSteps,
            actionFamilies: contract.actionFamilies,
            context: contract.context,
            startUrl,
            resetPolicy: contract.resetPolicy,
        },
        diagnostics,
    };
}
export function browserActionCorpusContract(input) {
    const context = normalizeBrowserRandomWalkContext(input.context);
    const seed = typeof input.seed === "string" && input.seed.length > 0 ? input.seed : "browser-action-corpus";
    return {
        schema: BROWSER_ACTION_CORPUS_SCHEMA,
        context,
        seed,
        maxSteps: normalizeBrowserRandomWalkMaxSteps(input.maxSteps ?? input.max_steps),
        startUrl: typeof input.startUrl === "string" ? input.startUrl : typeof input.start_url === "string" ? input.start_url : defaultBrowserRandomWalkStartUrl(context),
        includeFamilies: normalizeBrowserRandomWalkActionFamilies(input.includeFamilies ?? input.include_families),
        generatorPrefix: typeof input.generatorPrefix === "string" && input.generatorPrefix.length > 0 ? input.generatorPrefix : "wp-codebox",
        metadata: isPlainObject(input.metadata) ? input.metadata : undefined,
    };
}
export function planBrowserActionCorpus(contractInput, descriptorsInput) {
    const contract = isBrowserActionCorpusContract(contractInput) ? contractInput : browserActionCorpusContract(contractInput);
    const diagnostics = [];
    const descriptors = normalizeBrowserActionCorpusDescriptors(descriptorsInput);
    const candidates = seededBrowserActionCorpusOrder(descriptors, contract.seed);
    const steps = [];
    const descriptorIds = [];
    for (const descriptor of candidates) {
        if (steps.length >= contract.maxSteps)
            break;
        const planned = browserActionCorpusStep(descriptor, contract, steps.length);
        if (!planned || !contract.includeFamilies.includes(planned.family))
            continue;
        steps.push(planned.step);
        descriptorIds.push(descriptor.id);
    }
    if (steps.length === 0) {
        diagnostics.push({ code: "browser_action_corpus_no_steps", message: "No actionable controls produced executable seeded browser steps.", metadata: { descriptors: descriptors.length } });
    }
    const fillSteps = steps.filter((step) => step.kind === "fill" || step.kind === "press").length;
    const clickSteps = steps.filter((step) => step.kind === "click").length;
    const selectSteps = steps.filter((step) => step.kind === "select").length;
    return {
        schema: BROWSER_ACTION_CORPUS_SCHEMA,
        status: steps.length > 0 ? "planned" : "empty",
        context: contract.context,
        seed: contract.seed,
        maxSteps: contract.maxSteps,
        startUrl: contract.startUrl,
        descriptors,
        steps,
        replay: {
            schema: BROWSER_ACTION_CORPUS_SCHEMA,
            seed: contract.seed,
            maxSteps: contract.maxSteps,
            context: contract.context,
            startUrl: contract.startUrl,
            descriptorIds,
            steps,
        },
        observations: {
            descriptorsDiscovered: descriptors.length,
            descriptorsSelected: descriptorIds.length,
            stepsPlanned: steps.length,
            fillSteps,
            clickSteps,
            selectSteps,
        },
        diagnostics,
    };
}
export function browserActionCorpusArtifact(contractInput, descriptors, capturedAt) {
    const contract = isBrowserActionCorpusContract(contractInput) ? contractInput : browserActionCorpusContract(contractInput);
    return {
        schema: BROWSER_ACTION_CORPUS_ARTIFACT_SCHEMA,
        contract,
        plan: planBrowserActionCorpus(contract, descriptors),
        capturedAt,
    };
}
function isBrowserActionCorpusContract(value) {
    return value.schema === BROWSER_ACTION_CORPUS_SCHEMA;
}
function normalizeBrowserRandomWalkContext(value) {
    return BROWSER_RANDOM_WALK_CONTEXTS.includes(String(value)) ? value : "browser";
}
function normalizeBrowserRandomWalkMaxSteps(value) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric))
        return 8;
    return Math.max(1, Math.min(Math.floor(numeric), 50));
}
function normalizeBrowserRandomWalkActionFamilies(value) {
    const raw = Array.isArray(value) ? value : [];
    const normalized = raw.filter((item) => BROWSER_RANDOM_WALK_ACTION_FAMILIES.includes(String(item)));
    return normalized.length > 0 ? [...new Set(normalized)] : ["click", "fill", "press", "capture"];
}
function defaultBrowserRandomWalkStartUrl(context) {
    if (context === "admin")
        return "/wp-admin/";
    if (context === "editor")
        return "/wp-admin/post-new.php";
    return "/";
}
function browserRandomWalkStep(family, contract, index) {
    if (family === "navigate")
        return { kind: "navigate", url: contract.startUrl ?? defaultBrowserRandomWalkStartUrl(contract.context), waitFor: "load" };
    if (family === "click")
        return { kind: "click", selector: "a, button, input[type='submit'], .button" };
    if (family === "fill")
        return { kind: "fill", selector: "input[type='search'], input[type='text'], textarea", value: `fuzz-${contract.seed}-${index}` };
    if (family === "press")
        return { kind: "press", key: index % 2 === 0 ? "Tab" : "Escape" };
    if (family === "select")
        return { kind: "select", selector: "select", value: "" };
    if (family === "capture")
        return { kind: "capture" };
    return undefined;
}
function normalizeBrowserActionCorpusDescriptors(descriptors) {
    const seen = new Set();
    const normalized = [];
    for (const descriptor of descriptors) {
        if (!descriptor || typeof descriptor.selector !== "string" || descriptor.selector.length === 0 || typeof descriptor.id !== "string" || descriptor.id.length === 0)
            continue;
        if (descriptor.disabled || descriptor.readonly || seen.has(descriptor.id))
            continue;
        seen.add(descriptor.id);
        normalized.push({
            id: descriptor.id,
            kind: descriptor.kind,
            selector: descriptor.selector,
            ...(typeof descriptor.label === "string" && descriptor.label.length > 0 ? { label: descriptor.label } : {}),
            ...(typeof descriptor.name === "string" && descriptor.name.length > 0 ? { name: descriptor.name } : {}),
            ...(typeof descriptor.role === "string" && descriptor.role.length > 0 ? { role: descriptor.role } : {}),
            ...(typeof descriptor.type === "string" && descriptor.type.length > 0 ? { type: descriptor.type.toLowerCase() } : {}),
            ...(typeof descriptor.formId === "string" && descriptor.formId.length > 0 ? { formId: descriptor.formId } : {}),
            ...(typeof descriptor.href === "string" && descriptor.href.length > 0 ? { href: descriptor.href } : {}),
            ...(Array.isArray(descriptor.optionValues) ? { optionValues: descriptor.optionValues.filter((value) => typeof value === "string") } : {}),
        });
    }
    return normalized;
}
function seededBrowserActionCorpusOrder(descriptors, seed) {
    return [...descriptors].sort((a, b) => deterministicHash(`${seed}:${a.id}`) - deterministicHash(`${seed}:${b.id}`) || a.id.localeCompare(b.id));
}
function browserActionCorpusStep(descriptor, contract, index) {
    if (descriptor.kind === "select") {
        const values = descriptor.optionValues?.filter((value) => value.length > 0) ?? [];
        if (values.length === 0)
            return undefined;
        return { family: "select", step: { kind: "select", selector: descriptor.selector, value: pickDeterministic(values, `${contract.seed}:${descriptor.id}`) } };
    }
    if (descriptor.kind === "textarea" || descriptor.kind === "input") {
        const type = normalizeBrowserActionCorpusGeneratorKind(descriptor.kind === "textarea" ? "textarea" : descriptor.type);
        if (type === "checkbox" || type === "radio")
            return { family: "click", step: { kind: "click", selector: descriptor.selector } };
        return { family: "fill", step: { kind: "fill", selector: descriptor.selector, value: browserActionCorpusGeneratedValue(type, contract, descriptor, index) } };
    }
    if (descriptor.kind === "button")
        return { family: "click", step: { kind: "click", selector: descriptor.selector } };
    if (descriptor.kind === "link")
        return { family: "click", step: { kind: "click", selector: descriptor.selector } };
    return undefined;
}
function normalizeBrowserActionCorpusGeneratorKind(value) {
    const normalized = String(value || "text").toLowerCase();
    if (BROWSER_ACTION_CORPUS_GENERATOR_KINDS.includes(normalized))
        return normalized;
    return "text";
}
function browserActionCorpusGeneratedValue(kind, contract, descriptor, index) {
    const suffix = deterministicHash(`${contract.seed}:${descriptor.id}:${index}`).toString(36).slice(0, 8);
    const prefix = contract.generatorPrefix.replace(/[^a-zA-Z0-9._-]+/g, "-") || "wp-codebox";
    if (kind === "email")
        return `${prefix}-${suffix}@example.test`;
    if (kind === "url")
        return `https://example.test/${prefix}-${suffix}`;
    if (kind === "number")
        return String((deterministicHash(`${contract.seed}:${descriptor.id}`) % 900) + 100);
    if (kind === "password")
        return `${prefix}-${suffix}-Passw0rd!`;
    if (kind === "search")
        return `${prefix} search ${suffix}`;
    if (kind === "textarea")
        return `${prefix} generated text ${suffix}`;
    return `${prefix}-${suffix}`;
}
function pickDeterministic(items, seed) {
    return items[deterministicHash(seed) % items.length];
}
function deterministicHash(input) {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
//# sourceMappingURL=browser-interaction.js.map