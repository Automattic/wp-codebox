# Runner Workspace Seed Policy

Runner workspaces are copied from a bounded, disposable snapshot. The snapshot excludes generated trees and credential material before an agent can read it: `.env` and `.env.*` except `.env.example`, `.npmrc`, `.yarnrc.yml` (it can carry registry auth), `.pypirc`, `.netrc`, `auth.json`, common credential files, SSH private-key names, and private-key extensions.

Snapshot provenance records only a digest, copied file and byte counts, the policy patterns, and aggregate exclusion categories/counts. It never records excluded path names or the temporary snapshot location.
