# Native PHP Runtime Adapter

`runtime.backend: "wordpress-native"` selects the native adapter without changing
backend-neutral recipe command IDs. The adapter never substitutes host PHP,
ambient credentials, or production state when a contained driver is unavailable.

## Driver Contract

The CLI loads an adapter-owned contained driver from `runtime.backendPackage` when
the backend is `wordpress-native`. Its package uses `kind: "native"` and exports
`createNativeRuntimeDriver()`. The driver must report a digest-pinned container
image, PHP version and SAPI, persistent enabled OPcache evidence, at least two HTTP
workers, and a disposable managed-runtime-service database. Startup rejects
incomplete evidence and destroys a partially created runtime.

Before accepting commands, the driver persists
`wp-codebox/native-runtime-provenance/v1` in the run artifact directory and returns
its path and SHA-256. The evidence identifies the backend, PHP/SAPI, image digest,
OPcache configuration/status, worker model, managed database integration, and that
measurements are local representative evidence rather than production RUM. The
driver owns process and container lifecycle; `destroy()` is single-flight and the
adapter terminalizes the runtime even when driver cleanup reports an error.

Browser commands remain backend-neutral. A native driver must expose the local
preview and authenticated fixture workflow through the existing browser-action
contract; it must not use caller browser credentials.

`wordpress.browser-actions` must declare `auth=wordpress-admin` or
`auth=storage-state`. Native drivers accept only runtime-generated fixture state;
they must not import a caller profile or ambient browser credentials.

## HTTP Concurrency

The driver records its resolved worker count and worker model in
`provenance.httpConcurrency`. This is local representative evidence, not
production RUM. Benchmark workloads should record cold startup, warm no-op PHP,
and a dynamic WordPress request for both `wordpress-playground` and
`wordpress-native` using `wordpress.bench`.

The native provenance contract records that all three cases are covered. Cold
startup crosses a worker/process boundary, warm no-op PHP retains the shared
OPcache, and the dynamic request exercises WordPress routing. These are local
representative measurements, not production RUM.

## Example selection

```json
{
  "runtime": {
    "backend": "wordpress-native",
    "backendPackage": {
      "kind": "native",
      "source": "./contained-native-driver"
    }
  }
}
```

The native package is responsible for translating the existing backend-neutral
`wordpress.*` commands, including browser actions and fixture authentication, into
its contained runtime. It must not read host PHP configuration, browser profiles,
ambient credentials, or production state.
