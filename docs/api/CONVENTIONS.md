# Operation API conventions

- Creator interfaces and agents call the same operation implementation.
- State-changing calls accept an idempotency key once remote APIs are introduced.
- Every write names its source project and base version where applicable.
- Errors have a stable machine code and a plain-language message.
- Source native files are read-only during save, inspection and comparison.
- High-risk actions require explicit permission and create audit records.
