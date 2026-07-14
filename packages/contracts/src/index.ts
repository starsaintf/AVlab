export const SCHEMA_VERSION = "0.1" as const;

export type CapabilityLevel = "U0" | "U1" | "U2" | "U3" | "U4" | "U5";
export type EntryKind = "file" | "directory" | "symlink";
export type VersionKind = "named" | "recovery" | "agent-proposal";

export interface ProjectDescriptor {
  schema: "avlab.project/0.1";
  projectId: string;
  name: string;
  createdAt: string;
  rootKind: "directory" | "single-file";
  includePaths: string[];
  defaultDirection: string;
  capabilityLevel: CapabilityLevel;
  extensions: Record<string, unknown>;
}

export interface ChunkRef {
  contentId: string;
  size: number;
  offset: number;
}

export interface PackageEntry {
  path: string;
  kind: EntryKind;
  mode: number;
  mtimeMs: number;
  size?: number;
  contentId?: string;
  chunks?: ChunkRef[];
  linkTarget?: string;
}

export interface PackageManifest {
  schema: "avlab.package/0.1";
  packageId: string;
  projectId: string;
  createdAt: string;
  entries: PackageEntry[];
  totalBytes: number;
  uniqueBytesWritten: number;
}

export interface VersionRecord {
  schema: "avlab.version/0.1";
  versionId: string;
  projectId: string;
  parentVersionIds: string[];
  direction: string;
  kind: VersionKind;
  message: string;
  createdAt: string;
  createdBy: {principalId: string; onBehalfOf?: string};
  packageId: string;
  manifestPath: string;
}

export interface FileChange {
  path: string;
  change: "added" | "removed" | "modified" | "metadata";
  beforeContentId?: string;
  afterContentId?: string;
}

export interface CompareResult {
  fromVersionId: string;
  toVersionId: string;
  changes: FileChange[];
}

export interface StorageStatus {
  objectCount: number;
  storedBytes: number;
  reachableObjectCount: number;
  reachableBytes: number;
  missingObjects: string[];
}
