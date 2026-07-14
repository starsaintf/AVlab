# Release and migration policy

AVlab uses preview and stable release channels. Durable schemas and operation APIs are versioned independently from clients. Migrations must be reversible or create a verified backup. No release may make an earlier saved native package unrestorable. Release artifacts should be reproducible and signed before 1.0.
