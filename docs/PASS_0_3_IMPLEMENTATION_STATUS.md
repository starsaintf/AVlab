# Passes 0–3 implementation status

## Pass 0 — Project constitution and architecture lock

Implemented:

- npm workspace monorepo;
- public project, package and version contracts;
- JSON Schemas and schema conformance tests;
- open-source licensing declarations;
- governance, contribution, DCO, security and code-of-conduct documents;
- compatibility levels U0–U5;
- schema, API, fixture, migration and release policies;
- architecture decisions and local threat model;
- continuous-integration workflow.

## Pass 1 — Universal local save and restore

Implemented:

- initialize a single native file or full project directory;
- preserve unknown and proprietary files without parsing them;
- immutable named versions and quiet recovery versions;
- exact file bytes, directories, modes, timestamps and symbolic links;
- source-safe capture that detects files changing during save;
- project-exclusive operation lock;
- atomic manifests and SQLite WAL metadata;
- staged restoration with rollback backup;
- interrupted-save recovery and interrupted-restore rollback;
- file-level version comparison;
- CLI operations for initialize, save, list, compare, restore and verify.

## Pass 2 — Large-media storage and efficient versioning

Implemented:

- deterministic content-defined media chunking;
- SHA-256 object identities;
- reuse of identical chunks across files and versions;
- resumable filesystem/NAS/external-drive storage copies;
- destination integrity verification after resumed copies;
- object verification and corrupt-object rejection;
- reachability-based garbage collection;
- storage status and quota support;
- configurable filesystem-backed object-store location.

## Pass 3 — Desktop product and crash recovery

Implemented:

- authenticated loopback-only local bridge;
- creator operation API;
- project watcher and unsaved-change state;
- debounced quiet recovery points;
- plain-language React creator interface;
- save, history, compare and restore flows;
- responsive desktop and mobile review layout;
- Electron desktop-shell source with isolated renderer settings;
- project picker and automatic project initialization;
- bridge and watcher integration tests.

## Validation completed

- TypeScript type checking passed across all workspaces.
- Production builds passed for contracts, core, CLI, bridge, React interface and Electron shell source.
- 13 automated tests passed: 2 schema, 8 core and 3 bridge tests.
- A real CLI scenario initialized an unknown `.flp`, saved two versions, found the changed native file, restored the first version and verified all stored objects.

## Sandbox limitation

The Electron shell source compiles, but a packaged Electron runtime was not produced in the original sandbox because Electron's post-install binary download was unavailable. The complete React interface, local bridge and operation flow were built and exercised through automated HTTP integration tests.
