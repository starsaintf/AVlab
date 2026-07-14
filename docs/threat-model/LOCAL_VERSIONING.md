# Threat model: local versioning

## Protected assets

Native project files, source media, saved versions, object-store integrity, local bridge credentials and creator intent.

## Trust boundaries

The project directory, `.avlab` metadata, adapters, the local bridge, browser/desktop clients and external storage locations.

## Primary abuse cases

- Malicious paths escaping the project root.
- Symlinks causing unintended external-file capture.
- Corrupt objects producing damaged restores.
- Concurrent save and restore operations.
- Interrupted restoration leaving a partial project.
- An unauthenticated local process calling bridge operations.
- Cache or metadata being mistaken for required media.

## Implemented mitigations

Paths are normalized and root-bound. Symlinks are recorded without being followed. Objects are addressed and verified by SHA-256. Project operations use an exclusive lock. Restores are staged with a rollback backup and recovery journal. The bridge binds to loopback and requires a random local session token. `.avlab` is excluded from project capture.

## Remaining work

Adapter sandboxing, signed adapter packages, malicious native-format parser fixtures and operating-system keychain storage arrive in later passes.
