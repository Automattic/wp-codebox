/** Contained native PHP runtime adapter. */
export { NativeRuntimeBackend, NativeRuntimeUnavailableError, createNativeRuntimeBackend, nativeRuntimeBackendProvider, type NativeRuntimeBackendOptions, type NativeRuntimeDriver, type NativeRuntimeDriverFactory, type NativeRuntimeProvenance, type NativeRuntimeProvenanceEvidence } from "./native-runtime.js"
export { createDockerNativeRuntimeDriver, NativeBrowserActionTimeoutError, NativeContainmentUnavailableError, type DockerNativeRuntimeDependencies } from "./docker-native-runtime.js"
