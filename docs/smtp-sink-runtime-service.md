# SMTP Sink Runtime Service

SMTP runtime services expose a provider-neutral host-side sink contract. Recipes use `host/smtp.inspect` and `host/smtp.reset`; neither operation is available to the sandbox runtime or requires a network policy grant.

```json
{ "command": "host/smtp.inspect", "args": ["service=mail", "limit=20", "recipient=person@example.test", "recipient-label=account", "subject-marker=Reset", "link-marker=/reset/"] }
```

`limit` is required to be between 1 and 100 when supplied. Inspection scans at most 100 captured messages and returns a bounded `wp-codebox/smtp-sink-inspection/v1` envelope containing the count, returned count, truncation status, per-run opaque message/recipient/link labels, marker matches, and link scheme/host class/path depth. Recipient labels must be short safe identifiers without secret-like terms. It never emits addresses, message bodies, subjects, URLs, tokens, loopback ports, provider machine details, or reusable content fingerprints. Service IDs, recipient filters, and marker inputs are represented only by per-operation opaque labels and lengths in execution evidence.

```json
{ "command": "host/smtp.reset", "args": ["service=mail"] }
```

Reset is deterministic and records a normalized `wp-codebox/smtp-sink-reset/v1` operation in managed service evidence. Checkpointed adversarial cases reset every declared SMTP sink after restoring their runtime checkpoint, because host-side sinks are outside a runtime checkpoint.

The current Docker SMTP provider maps this generic contract to its private inspection API. Provider API paths and payload shapes are not part of the recipe contract.
