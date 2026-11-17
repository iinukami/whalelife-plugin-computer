# Computer plugin development

Scope: this repository only. Use the public WhaleLife API; never modify the host or another plugin. Do not install into a running host or perform real user tasks as regression tests.

Keep Windows file scope, per-capability authorization, backups and offline execution enforceable. No unrestricted shell fallback. Preserve task snapshots for an already-started plugin task; new tasks use current grants. Do not claim a plugin task represents an entire model run when the public host API supplies no run identity.

Use Node 24. All tests own and clean their directories under `.artifacts/tests`. Native sandbox tests may only own uniquely named temporary AppContainer profiles and isolated fixture directories, must clean them, and must report cleanup failures. Never change global firewall rules or existing profiles.

Production sources and scripts carry the existing iinukami copyright, AGPL-3.0-only and LICENSE-ADDITIONAL notices. Do not commit local paths, configurations, credentials, task content, generated files, logs, backups or native binaries. Check the exact staged content, then make a local commit; no push or release.
