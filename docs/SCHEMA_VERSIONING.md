# Schema versioning

Every durable AVlab object includes a schema identifier such as `avlab.project/0.1`.

- Patch releases may clarify validation without changing valid data.
- Minor schema versions may add optional fields. Readers must preserve unknown fields.
- Breaking changes require a new schema identifier, migration code, fixtures and an ADR.
- Native packages and old versions must remain restorable even when semantic schemas evolve.
- Writers must never silently downgrade or discard unknown extension data.
