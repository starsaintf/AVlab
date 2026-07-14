# AVlab

AVlab is an open project layer for audiovisual work. This repository implements Passes 0–3: universal local project capture, immutable versions, content-addressed large-media storage, exact restoration, a secure local bridge and a creator-facing desktop interface.

AVlab does not need to understand a native DAW or editor format before protecting it. Unknown and proprietary files receive U0 compatibility: exact preservation, versions, comparison, verification and restoration. Deeper application adapters can be added later without replacing this foundation.

## Requirements

- Node.js 22.5 or later
- npm 10 or later

The current reference uses Node's built-in SQLite implementation. Node may print an experimental API warning; AVlab's database layer is isolated so it can be replaced without changing durable manifests.

## Install and verify

```bash
npm install
npm run typecheck
npm run test
npm run build
```

## Use the CLI

```bash
# Connect any native project file or complete project folder
npm run avlab -- init /path/to/project --name "My Project"

# Save safe versions
npm run avlab -- save /path/to/project --message "First safe version"
npm run avlab -- save /path/to/project --message "Shorter intro" --direction "Radio edit"

# Inspect and compare
npm run avlab -- versions /path/to/project
npm run avlab -- compare /path/to/project <older-version-id> <newer-version-id>

# Restore and verify
npm run avlab -- restore /path/to/project <version-id>
npm run avlab -- verify /path/to/project

# Copy stored media to an external disk or NAS
npm run avlab -- copy-storage /path/to/project /path/to/other/storage

# Open the creator interface
npm run avlab -- bridge /path/to/project
```

The bridge prints a loopback-only session URL. Open it to save versions, try another direction, compare work and restore earlier states.

## Workspace map

- `packages/contracts`: public TypeScript contracts and JSON Schemas.
- `packages/core`: local project, version, chunk storage, restore and verification engine.
- `apps/cli`: creator and automation command line.
- `services/local-bridge`: authenticated operation API and project watcher.
- `apps/desktop`: React creator interface.
- `apps/desktop-shell`: Electron host source.
- `docs/specification`: AVlab v0.1 architecture and implementation documents.

## Product language

Creator interfaces use **Project**, **Save version**, **Try another direction**, **What changed** and **Restore**. Internal code may use precise version-control terminology where it improves implementation clarity.

See [`docs/PASS_0_3_IMPLEMENTATION_STATUS.md`](docs/PASS_0_3_IMPLEMENTATION_STATUS.md) for completed capabilities, validation and the sandbox packaging limitation.
