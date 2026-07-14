import {DatabaseSync} from "node:sqlite";
import type {VersionRecord} from "@avlab/contracts";

export class ProjectDatabase {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        version_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        parent_ids TEXT NOT NULL,
        package_id TEXT NOT NULL,
        manifest_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS heads (
        direction TEXT PRIMARY KEY,
        version_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  hasVersion(versionId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM versions WHERE version_id = ?").get(versionId));
  }

  addVersion(version: VersionRecord): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO versions
        (version_id, project_id, direction, kind, message, created_at, created_by, parent_ids, package_id, manifest_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(version.versionId, version.projectId, version.direction, version.kind, version.message,
          version.createdAt, JSON.stringify(version.createdBy), JSON.stringify(version.parentVersionIds),
          version.packageId, version.manifestPath);
      this.db.prepare(`INSERT INTO heads(direction, version_id) VALUES (?, ?)
        ON CONFLICT(direction) DO UPDATE SET version_id = excluded.version_id`)
        .run(version.direction, version.versionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getHead(direction: string): string | undefined {
    const row = this.db.prepare("SELECT version_id FROM heads WHERE direction = ?").get(direction) as {version_id: string} | undefined;
    return row?.version_id;
  }

  getVersion(versionId: string): VersionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM versions WHERE version_id = ?").get(versionId) as Record<string, string> | undefined;
    return row ? rowToVersion(row) : undefined;
  }

  listVersions(includeRecovery = false): VersionRecord[] {
    const sql = includeRecovery
      ? "SELECT * FROM versions ORDER BY created_at DESC"
      : "SELECT * FROM versions WHERE kind != 'recovery' ORDER BY created_at DESC";
    return (this.db.prepare(sql).all() as Record<string, string>[]).map(rowToVersion);
  }
}

function rowToVersion(row: Record<string, string>): VersionRecord {
  return {
    schema: "avlab.version/0.1",
    versionId: row.version_id!,
    projectId: row.project_id!,
    direction: row.direction!,
    kind: row.kind as VersionRecord["kind"],
    message: row.message!,
    createdAt: row.created_at!,
    createdBy: JSON.parse(row.created_by!) as VersionRecord["createdBy"],
    parentVersionIds: JSON.parse(row.parent_ids!) as string[],
    packageId: row.package_id!,
    manifestPath: row.manifest_path!
  };
}
