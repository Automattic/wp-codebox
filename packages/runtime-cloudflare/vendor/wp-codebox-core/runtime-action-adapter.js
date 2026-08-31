import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { normalizeRootedPath, pathIsWithinRoot, relativePathIsWithinRoot } from "./file-tree-policy.js";
import { planBrowserRandomWalk } from "./browser-interaction.js";
import { performanceObservation } from "./performance-observation.js";
import { runtimeEpisodeDigest } from "./runtime-episode.js";
import { WORDPRESS_CRUD_OPERATION_SCHEMA, normalizeWordPressCrudOperation } from "./wordpress-crud-contracts.js";
import { WORDPRESS_DB_OPERATION_SCHEMA, normalizeWordPressDbOperation } from "./wordpress-db-contracts.js";
export const RUNTIME_ACTION_OBSERVATION_SCHEMA = "wp-codebox/runtime-action-observation/v1";
export const SANDBOX_WORKSPACE_ROOT = "/workspace";
export class RuntimeActionPolicyError extends Error {
    action;
    code = "runtime-action-policy-violation";
    constructor(message, action) {
        super(message);
        this.action = action;
        this.name = "RuntimeActionPolicyError";
    }
}
export class RuntimeActionExecutionError extends Error {
    artifactRefs;
    constructor(message, artifactRefs) {
        super(message);
        this.artifactRefs = artifactRefs;
        this.name = "RuntimeActionExecutionError";
    }
}
export async function runRuntimeAction(episode, action, policy = {}) {
    if (action.type === "wp_cli") {
        return runRuntimeWpCliAction(episode, action);
    }
    if (action.type === "php") {
        return runRuntimePhpAction(episode, action);
    }
    if (action.type === "rest_request") {
        return runRuntimeRestRequestAction(episode, action);
    }
    if (action.type === "crud_operation") {
        return runRuntimeWordPressCrudOperationAction(episode, action);
    }
    if (action.type === "db_operation") {
        return runRuntimeWordPressDbOperationAction(episode, action);
    }
    if (action.type === "browser") {
        return runRuntimeBrowserAction(episode, action);
    }
    if (action.type === "random_walk") {
        return runRuntimeBrowserRandomWalkAction(episode, action);
    }
    if (action.type === "browser_probe") {
        return runRuntimeBrowserProbeAction(episode, action);
    }
    if (action.type === "editor_open") {
        return runRuntimeEditorOpenAction(episode, action);
    }
    if (action.type === "editor_actions") {
        return runRuntimeEditorActionsAction(episode, action);
    }
    if (action.type === "editor_validate_blocks") {
        return runRuntimeEditorValidateBlocksAction(episode, action);
    }
    if (action.type === "admin_page") {
        return runRuntimeAdminPageAction(episode, action);
    }
    if (action.type === "page") {
        return runRuntimePageAction(episode, action);
    }
    if (action.type === "sequence") {
        throw new RuntimeActionPolicyError("Runtime action sequences must be expanded by the fuzz-suite runner before episode execution.", action);
    }
    if (action.type === "wordpress_plugin_setup") {
        return runRuntimeMappedCommandAction(episode, action, "wordpress.plugin-setup");
    }
    if (action.type === "wordpress_plugin_state") {
        return runRuntimeMappedCommandAction(episode, action, "wordpress.plugin-state");
    }
    if (action.type === "wordpress_theme_setup") {
        return runRuntimeMappedCommandAction(episode, action, "wordpress.theme-setup");
    }
    if (action.type === "wordpress_hook") {
        return runRuntimeMappedCommandAction(episode, action, "wordpress.invoke-hook");
    }
    if (action.type === "wordpress_cron_event") {
        return runRuntimeMappedCommandAction(episode, action, "wordpress.invoke-cron-event");
    }
    return runRuntimeFilesystemAction(episode, action, policy);
}
async function runRuntimePhpAction(episode, action) {
    const args = [`code=${action.code}`];
    if (action.bootstrap) {
        args.push(`bootstrap=${action.bootstrap}`);
    }
    const diagnostics = action.diagnostics ?? { capture: ["wpdb-queries"] };
    const step = await episode.step({
        kind: "command",
        command: "wordpress.run-php",
        args,
        diagnostics,
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    }, { type: "command-result" });
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout: step.execution.stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
async function runRuntimeWpCliAction(episode, action) {
    const step = await episode.step({
        kind: "command",
        command: "wordpress.wp-cli",
        args: [`command=${normalizeWpCliRuntimeActionCommand(action.command)}`],
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    }, { type: "command-result" });
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            command: action.command,
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout: step.execution.stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
async function runRuntimeMappedCommandAction(episode, action, command) {
    const step = await episode.step({
        kind: "command",
        command,
        args: actionArgs(action),
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    }, { type: "command-result" });
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout: step.execution.stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
function actionArgs(action) {
    return Object.entries(action).flatMap(([key, value]) => {
        if (value === undefined || key === "type" || key === "timeout_ms") {
            return [];
        }
        if (key === "args" && Array.isArray(value)) {
            return [`args-json=${JSON.stringify(value)}`];
        }
        return [`${key.replace(/_/g, "-")}=${String(value)}`];
    });
}
async function runRuntimeRestRequestAction(episode, action) {
    const args = [`path=${action.path}`];
    if (action.method) {
        args.push(`method=${action.method}`);
    }
    if (action.headers) {
        args.push(`headers-json=${JSON.stringify(action.headers)}`);
    }
    if (action.params) {
        args.push(`params-json=${JSON.stringify(action.params)}`);
    }
    if (action.body_json !== undefined) {
        args.push(`body-json=${JSON.stringify(action.body_json)}`);
    }
    else if (action.body !== undefined) {
        args.push(`body=${action.body}`);
    }
    args.push(...captureArgs(action));
    const step = await episode.step({
        kind: "http",
        command: "wordpress.rest-request",
        args,
        method: action.method ?? "GET",
        path: action.path,
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    }, { type: "command-result" });
    let stdout = step.execution.stdout;
    try {
        stdout = JSON.parse(step.execution.stdout);
    }
    catch {
        // Keep raw stdout when a backend returns non-JSON diagnostics.
    }
    const normalized = normalizeRuntimeRestRequestResult(action, step, stdout);
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: normalized,
        artifactRefs: step.observation?.artifactRefs,
    });
}
function captureArgs(action) {
    return [
        ...(action.capture && Object.keys(action.capture).length > 0 ? [`capture-json=${JSON.stringify(action.capture)}`] : []),
        ...(typeof action.enableQueryCapture === "boolean" ? [`enable-query-capture=${action.enableQueryCapture ? "true" : "false"}`] : []),
    ];
}
async function runRuntimeWordPressCrudOperationAction(episode, action) {
    const operation = normalizeWordPressCrudOperation({ schema: WORDPRESS_CRUD_OPERATION_SCHEMA, ...action });
    const step = await episode.step({
        kind: "command",
        command: "wordpress.crud-operation",
        args: [`operation-json=${JSON.stringify(operation)}`],
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    }, { type: "command-result" });
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            operation,
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout: step.execution.stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
async function runRuntimeWordPressDbOperationAction(episode, action) {
    const operation = normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, ...action, operation: action.operation ?? "read" });
    const step = await episode.step({
        kind: "command",
        command: "wordpress.db-operation",
        args: [`operation-json=${JSON.stringify(operation)}`],
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    }, { type: "command-result" });
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            operation,
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout: step.execution.stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
function normalizeRuntimeRestRequestResult(action, step, stdout) {
    const response = stdout && typeof stdout === "object" && !Array.isArray(stdout) ? stdout : {};
    const startedAt = Date.parse(step.execution.startedAt);
    const finishedAt = Date.parse(step.execution.finishedAt);
    const durationMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? Math.max(0, finishedAt - startedAt) : undefined;
    const method = stringValue(response.method) ?? action.method ?? "GET";
    const path = stringValue(response.path) ?? action.path;
    const route = stringValue(response.route) ?? path;
    const headers = recordValue(response.headers) ?? {};
    const body = response.body ?? response.data ?? null;
    const diagnostics = {
        exitCode: step.execution.exitCode,
        stderr: step.execution.stderr,
        ...(recordValue(response.diagnostics) ?? {}),
    };
    return {
        method,
        path,
        route,
        status: typeof response.status === "number" ? response.status : undefined,
        headers,
        body,
        timing: {
            startedAt: step.execution.startedAt,
            finishedAt: step.execution.finishedAt,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(recordValue(response.timing) ?? {}),
        },
        diagnostics,
        mappedCommand: step.execution.command,
        args: step.execution.args,
        stdout,
        stderr: step.execution.stderr,
        executionId: step.execution.id,
        stepId: step.id,
    };
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
function recordValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
async function runRuntimeFilesystemAction(episode, action, policy) {
    const mountedPath = await resolveRuntimeActionMountedPath(action, policy);
    const data = await executeRuntimeFilesystemAction(action, mountedPath);
    const traceCommand = policy.filesystemTraceCommand ?? "inspect-mounted-inputs";
    const step = traceCommand
        ? await episode.step({
            kind: "filesystem",
            command: traceCommand,
            path: mountedPath.sandboxPath,
            operation: action.operation,
            description: `filesystem.${action.operation}`,
            metadata: {
                mountTarget: mountedPath.mount.target,
                mountMode: mountedPath.mount.mode,
            },
        }, { type: "mounts" })
        : undefined;
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            operation: action.operation,
            path: mountedPath.sandboxPath,
            mountTarget: mountedPath.mount.target,
            mountMode: mountedPath.mount.mode,
            ...data,
        },
        artifactRefs: step?.observation?.artifactRefs,
    });
}
async function runRuntimeBrowserAction(episode, action) {
    const args = [`steps-json=${JSON.stringify([runtimeBrowserCommandStep(action)])}`];
    if (action.url && action.operation !== "navigate") {
        args.unshift(`url=${action.url}`);
    }
    if (action.capture && action.capture.length > 0) {
        args.push(`capture=${action.capture.join(",")}`);
    }
    const step = await episode.step({
        kind: "browser",
        command: "wordpress.browser-actions",
        args,
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
        ...(action.selector ? { selector: action.selector } : {}),
        ...(action.url ? { url: action.url } : {}),
        operation: action.operation,
    }, { type: "browser-result" });
    let stdout = step.execution.stdout;
    try {
        stdout = JSON.parse(step.execution.stdout);
    }
    catch {
        // Keep raw stdout when a backend returns non-JSON diagnostics.
    }
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            operation: action.operation,
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
async function runRuntimeBrowserRandomWalkAction(episode, action) {
    const plan = planBrowserRandomWalk(action);
    if (plan.status === "unsupported") {
        throw new RuntimeActionPolicyError(`Browser random walk is unsupported: ${plan.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`, action);
    }
    const args = [`steps-json=${JSON.stringify(plan.steps)}`];
    if (action.capture && action.capture.length > 0) {
        args.push(`capture=${action.capture.join(",")}`);
    }
    const step = await episode.step({
        kind: "browser",
        command: "wordpress.browser-actions",
        args,
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
        operation: "random_walk",
    }, { type: "browser-result" });
    let stdout = step.execution.stdout;
    try {
        stdout = JSON.parse(step.execution.stdout);
    }
    catch {
        // Keep raw stdout when a backend returns non-JSON diagnostics.
    }
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            operation: "random_walk",
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
            randomWalk: plan,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
function runtimeBrowserCommandStep(action) {
    const commandAction = { kind: action.operation === "wait" ? "waitFor" : action.operation };
    for (const key of ["url", "selector", "text", "value", "key", "duration"]) {
        if (typeof action[key] === "string") {
            commandAction[key] = action[key];
        }
    }
    if (typeof action.wait_for === "string") {
        commandAction.waitFor = action.wait_for;
    }
    if (action.operation === "capture" && Array.isArray(action.capture)) {
        commandAction.capture = action.capture;
    }
    return commandAction;
}
async function runRuntimeBrowserProbeAction(episode, action) {
    const args = [`url=${action.url}`];
    if (action.wait_for) {
        args.push(`wait-for=${action.wait_for}`);
    }
    if (action.duration) {
        args.push(`duration=${action.duration}`);
    }
    if (action.capture && action.capture.length > 0) {
        args.push(`capture=${action.capture.join(",")}`);
    }
    if (action.viewport) {
        args.push(`viewport=${action.viewport}`);
    }
    const step = await episode.step({
        kind: "browser",
        command: "wordpress.browser-probe",
        args,
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
        url: action.url,
        operation: "probe",
    }, { type: "browser-result" });
    let stdout = step.execution.stdout;
    try {
        stdout = JSON.parse(step.execution.stdout);
    }
    catch {
        // Keep raw stdout when a backend returns non-JSON diagnostics.
    }
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
async function runRuntimeEditorOpenAction(episode, action) {
    const args = runtimeEditorOpenArgs(action);
    const step = await episode.step({
        kind: "browser",
        command: "wordpress.editor-open",
        args,
        ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
        ...(action.url ? { url: action.url } : {}),
        ...(action.target ? { target: action.target } : {}),
        operation: "editor_open",
    }, { type: "browser-result" });
    let stdout = step.execution.stdout;
    try {
        stdout = JSON.parse(step.execution.stdout);
    }
    catch {
        // Keep raw stdout when a backend returns non-JSON diagnostics.
    }
    const summary = recordValue(stdout);
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: {
            mappedCommand: step.execution.command,
            args: step.execution.args,
            exitCode: step.execution.exitCode,
            stdout,
            stderr: step.execution.stderr,
            executionId: step.execution.id,
            stepId: step.id,
            diagnostics: {
                exitCode: step.execution.exitCode,
                stderr: step.execution.stderr,
            },
            ...(summary?.target ? { target: summary.target } : {}),
            ...(summary?.finalUrl ? { finalUrl: summary.finalUrl } : {}),
            ...(summary?.files ? { files: summary.files } : {}),
            ...(summary?.summary ? { summary: summary.summary } : {}),
            ...(summary?.steps ? { steps: summary.steps } : {}),
            artifactRefs: step.observation?.artifactRefs ?? [],
        },
        artifactRefs: step.observation?.artifactRefs,
    });
}
async function runRuntimeEditorActionsAction(episode, action) {
    return runRuntimeEditorCommandAction(episode, action, "wordpress.editor-actions", runtimeEditorActionsArgs(action));
}
async function runRuntimeEditorValidateBlocksAction(episode, action) {
    return runRuntimeEditorCommandAction(episode, action, "wordpress.editor-validate-blocks", runtimeEditorValidateBlocksArgs(action));
}
async function runRuntimeEditorCommandAction(episode, action, command, args) {
    const step = await episode.step({ kind: "browser", command, args, ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}), operation: action.type }, { type: "browser-result" });
    let stdout = step.execution.stdout;
    try {
        stdout = JSON.parse(step.execution.stdout);
    }
    catch {
        // Keep raw stdout when a backend returns non-JSON diagnostics.
    }
    return runtimeActionObservation({
        type: action.type,
        action,
        step,
        data: { mappedCommand: step.execution.command, args: step.execution.args, exitCode: step.execution.exitCode, stdout, stderr: step.execution.stderr, executionId: step.execution.id, stepId: step.id },
        artifactRefs: step.observation?.artifactRefs,
    });
}
async function runRuntimeAdminPageAction(episode, action) {
    const path = action.path.startsWith("/wp-admin/") ? action.path : `/wp-admin/${action.path.replace(/^\/+/, "")}`;
    const observation = await runRuntimeBrowserProbeAction(episode, {
        type: "browser_probe",
        url: path,
        wait_for: action.wait_for,
        capture: action.capture,
        timeout_ms: action.timeout_ms,
    });
    return runtimeActionObservation({
        type: action.type,
        action,
        step: observation.step,
        data: { ...observation.data, path },
        artifactRefs: observation.artifactRefs,
    });
}
async function runRuntimePageAction(episode, action) {
    const observation = await runRuntimeBrowserProbeAction(episode, {
        type: "browser_probe",
        url: action.path,
        wait_for: action.wait_for,
        capture: action.capture,
        timeout_ms: action.timeout_ms,
    });
    return runtimeActionObservation({
        type: action.type,
        action,
        step: observation.step,
        data: { ...observation.data, path: action.path },
        artifactRefs: observation.artifactRefs,
    });
}
function runtimeEditorOpenArgs(action) {
    const args = [];
    if (action.target) {
        args.push(`target=${action.target}`);
    }
    if (action.post_id !== undefined) {
        args.push(`post-id=${action.post_id}`);
    }
    if (action.post_type) {
        args.push(`post-type=${action.post_type}`);
    }
    if (action.url) {
        args.push(`url=${action.url}`);
    }
    if (action.wait_selector) {
        args.push(`wait-selector=${action.wait_selector}`);
    }
    if (action.timeout_ms !== undefined) {
        args.push(`wait-timeout=${action.timeout_ms}ms`);
    }
    if (action.capture && action.capture.length > 0) {
        args.push(`capture=${action.capture.join(",")}`);
    }
    return args;
}
function runtimeEditorActionsArgs(action) {
    return [
        ...runtimeEditorOpenArgs(action),
        `steps-json=${JSON.stringify(action.steps)}`,
        ...(action.wait_timeout_ms !== undefined ? [`wait-timeout=${action.wait_timeout_ms}ms`] : []),
        ...(action.step_timeout_ms !== undefined ? [`step-timeout=${action.step_timeout_ms}ms`] : []),
    ];
}
function runtimeEditorValidateBlocksArgs(action) {
    return [
        ...(action.content !== undefined ? [`content=${action.content}`] : []),
        ...(action.content_file ? [`content-file=${action.content_file}`] : []),
        ...runtimeEditorOpenArgs(action),
        ...(action.validation_provider ? [`validation-provider=${action.validation_provider}`] : []),
    ];
}
function normalizeWpCliRuntimeActionCommand(command) {
    const trimmed = command.trim();
    return trimmed.startsWith("wp ") ? trimmed.slice(3).trimStart() : trimmed;
}
async function resolveRuntimeActionMountedPath(action, policy) {
    if (!action.path || action.path.includes("\0")) {
        throw new RuntimeActionPolicyError("Filesystem action path must be a non-empty path without null bytes", action);
    }
    const mounts = policy.mounts ?? [];
    const sandboxPath = normalizeSandboxRuntimeActionPath(action.path);
    const mount = mounts.find((candidate) => isRuntimeActionPathWithinRoot(sandboxPath, candidate.target));
    if (!mount) {
        throw new RuntimeActionPolicyError(`Filesystem action path is outside mounted workspace roots: ${action.path}`, action);
    }
    const hostPath = resolve(mount.source, relative(normalizeSandboxRuntimeActionPath(mount.target), sandboxPath));
    await assertRuntimeActionHostPathWithinMount(action, hostPath, mount.source);
    if (action.operation === "write" || action.operation === "delete") {
        assertRuntimeFilesystemWritable(action, sandboxPath, mount, policy);
    }
    return { mount, sandboxPath, hostPath };
}
function normalizeSandboxRuntimeActionPath(path) {
    return normalizeRootedPath(path, SANDBOX_WORKSPACE_ROOT);
}
function isRuntimeActionPathWithinRoot(path, root) {
    return relativePathIsWithinRoot(normalizeSandboxRuntimeActionPath(path), normalizeSandboxRuntimeActionPath(root));
}
async function assertRuntimeActionHostPathWithinMount(action, hostPath, source) {
    const root = await realpath(source);
    const existingPath = action.operation === "write" ? dirname(hostPath) : hostPath;
    let real;
    try {
        real = await realpath(existingPath);
    }
    catch (error) {
        if (action.operation !== "write") {
            throw error;
        }
        real = await nearestExistingRuntimeActionParent(existingPath, root);
    }
    if (!pathIsWithinRoot(real, root)) {
        throw new RuntimeActionPolicyError(`Filesystem action path resolves outside mounted workspace root: ${action.path}`, action);
    }
}
async function nearestExistingRuntimeActionParent(path, root) {
    let current = path;
    while (current !== dirname(current)) {
        try {
            return await realpath(current);
        }
        catch {
            current = dirname(current);
            if (!current.startsWith(root)) {
                return root;
            }
        }
    }
    return root;
}
function assertRuntimeFilesystemWritable(action, sandboxPath, mount, policy) {
    if (policy.filesystem && policy.filesystem !== "readwrite-mounts") {
        throw new RuntimeActionPolicyError(`Filesystem action requires readwrite-mounts policy: ${action.operation}`, action);
    }
    if (mount.mode !== "readwrite") {
        throw new RuntimeActionPolicyError(`Filesystem action requires a readwrite mount: ${mount.target}`, action);
    }
    const writableRoots = policy.writableRoots ?? [mount.target];
    if (!writableRoots.some((root) => isRuntimeActionPathWithinRoot(sandboxPath, root))) {
        throw new RuntimeActionPolicyError(`Filesystem action path is outside writable roots: ${action.path}`, action);
    }
}
async function executeRuntimeFilesystemAction(action, mountedPath) {
    if (action.operation === "list") {
        const entries = await readdir(mountedPath.hostPath, { withFileTypes: true });
        return {
            entries: entries
                .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }))
                .sort((left, right) => left.name.localeCompare(right.name)),
        };
    }
    if (action.operation === "read") {
        const content = await readFile(mountedPath.hostPath, "utf8");
        return { content, bytes: Buffer.byteLength(content, "utf8") };
    }
    if (action.operation === "write") {
        await mkdir(dirname(mountedPath.hostPath), { recursive: true });
        await writeFile(mountedPath.hostPath, action.content ?? "");
        return { bytes: Buffer.byteLength(action.content ?? "", "utf8") };
    }
    await rm(mountedPath.hostPath, { recursive: true, force: true });
    return { deleted: true };
}
function runtimeActionObservation(input) {
    const observedAt = new Date().toISOString();
    const performance = normalizeRuntimeActionPerformanceObservation(input);
    const observation = {
        schema: RUNTIME_ACTION_OBSERVATION_SCHEMA,
        type: input.type,
        status: "ok",
        action: input.action,
        data: input.data,
        observedAt,
        performance,
        ...(input.step ? { step: input.step } : {}),
        ...(input.artifactRefs && input.artifactRefs.length > 0 ? { artifactRefs: input.artifactRefs } : {}),
    };
    return {
        ...observation,
        digest: runtimeEpisodeDigest(observation),
    };
}
function normalizeRuntimeActionPerformanceObservation(input) {
    const diagnostics = recordValue(input.step?.execution.diagnostics);
    const explicit = recordValue(input.data.performance) ?? recordValue(diagnostics?.performance);
    const startedAt = input.step?.execution.startedAt;
    const finishedAt = input.step?.execution.finishedAt;
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN;
    const durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : undefined;
    const timing = recordValue(explicit?.timing) ?? recordValue(input.data.timing);
    const browser = normalizeRuntimeActionBrowserPerformance(input.data);
    return performanceObservation({
        command: input.step?.execution.command,
        target: runtimeActionTarget(input.action),
        timing: {
            ...(startedAt ? { startedAt } : {}),
            ...(finishedAt ? { finishedAt } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...timing,
        },
        memory: recordValue(explicit?.memory),
        database: recordValue(explicit?.database),
        hooks: recordValue(explicit?.hooks),
        network: recordValue(explicit?.network),
        browser: recordValue(explicit?.browser) ?? browser,
        ...(input.artifactRefs && input.artifactRefs.length > 0 ? { artifactRefs: input.artifactRefs } : {}),
        metadata: {
            actionType: input.action.type,
            ...(input.step ? { stepId: input.step.id, executionId: input.step.execution.id } : {}),
        },
    });
}
function normalizeRuntimeActionBrowserPerformance(data) {
    const stdout = recordValue(data.stdout);
    const summary = recordValue(stdout?.summary) ?? recordValue(data.summary);
    const files = recordValue(stdout?.files) ?? recordValue(data.files);
    if (!summary && !files) {
        return undefined;
    }
    return {
        metrics: recordValue(summary?.metrics),
        admin: {
            ...(summary ?? {}),
            ...(files ? { files } : {}),
        },
    };
}
function runtimeActionTarget(action) {
    if ("path" in action)
        return action.path;
    if ("url" in action)
        return action.url;
    if ("command" in action)
        return action.command;
    if (action.type === "php")
        return action.bootstrap ?? "php";
    return action.type;
}
//# sourceMappingURL=runtime-action-adapter.js.map