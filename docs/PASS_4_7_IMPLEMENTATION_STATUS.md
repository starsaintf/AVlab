# AVlab Passes 4–7 implementation status

## Pass 4 — Preview and media inspection

Implemented:

- immutable preview records connected to saved versions;
- user-export attachment;
- FFmpeg audio and video proxy generation;
- `compact`, `review` and `high-quality` proxy profiles;
- FFprobe media inspection with duration, dimensions, frame rate, codec and audio metadata;
- generated waveform images for audio and thumbnails for video or image sources;
- image preview support;
- automatic media candidate selection;
- cancellation support for preview jobs;
- preview integrity hashes;
- local bridge playback;
- CLI preview commands;
- clear fallback when media tools or playable sources are unavailable.

Current boundary:

Native host rendering is represented by the preview source contract but requires U5 editor adapters in later passes.

## Pass 5 — Remote server and synchronization

Implemented:

- self-hosted Fastify server;
- non-empty bearer-token authentication;
- filesystem content-addressed object storage;
- SQLite server metadata;
- manifest negotiation and missing-object calculation;
- chunked uploads that resume from the last accepted byte;
- HTTP Range downloads;
- object hash verification and atomic publication;
- deduplicated object upload;
- durable local and server synchronization receipts;
- remote version and creative-direction head publication;
- project cloning;
- metadata, proxy and full pull modes;
- conflict-safe pulls that never silently move a diverged local direction;
- explicit conflict listing and resolution;
- offline-created version preservation;
- portable project export and import;
- Docker Compose reference deployment.

Current boundary:

The reference server is deliberately a modular monolith using local filesystem storage and SQLite. PostgreSQL and S3-compatible production backends can implement the same public operations without changing the project contracts.

## Pass 6 — Browser review and feedback

Implemented:

- cryptographically random review links stored as hashes rather than plaintext tokens;
- optional review expiry and revocation;
- separate view, comment, approve and download permissions;
- proxy-only browser access;
- gated preview downloads;
- previous/proposed A/B selection;
- audio, video and image playback;
- comments attached to current playback time;
- threaded replies and feedback resolution;
- approval, rejection and change requests;
- deterministic latest-decision status calculation;
- configurable required approval count;
- review activity and notification records;
- standalone React review client;
- no requirement for the source DAW/editor.

Current identity boundary:

Review-link tokens control access. Guest reviewer display names are self-declared in this reference slice; verified organization identity and SSO-backed review attribution belong to later identity hardening work.

## Pass 7 — Collaboration and creative directions

Implemented:

- named alternative creative directions;
- explicit base-version selection;
- independent direction heads;
- parallel version preservation;
- offline divergence detection;
- proposal records and package-level proposal comparison;
- proposal-to-review workflow;
- review status synchronization back to proposals;
- approved-version marker;
- project-member role records;
- member access-token revocation;
- team records;
- role enforcement across server operations;
- project activity and review notification feeds;
- no silent overwrite during pull or offline reconciliation.

Automatic structured combination is intentionally not included here. It belongs to Pass 11 after the Open Project Graph and semantic comparison engine exist.

## Validation

The automated suite validates:

- real FFmpeg audio preview generation, metadata inspection and waveform creation;
- portable export/import with media and previews;
- creative direction ancestry and package comparison;
- local and remote divergence preservation;
- proposal creation;
- authenticated remote synchronization;
- resumable object upload and ranged download;
- synchronization receipts and conflict records;
- complete project cloning and restoration;
- browser review retrieval and permission enforcement;
- review expiry and member-token revocation;
- time-anchored comments and decisions;
- local bridge security and automatic recovery;
- all earlier Pass 0–3 behavior.
