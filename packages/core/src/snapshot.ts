import {lstat, readdir, readlink, rm} from "node:fs/promises";
import path from "node:path";
import type {ChunkRef, PackageEntry, PackageManifest, VersionKind, VersionRecord} from "@avlab/contracts";
import {chunkFile} from "./chunker.js";
import {AvlabError} from "./errors.js";
import {newId} from "./ids.js";
import {atomicWriteJson} from "./json.js";
import {acquireProjectLock, releaseProjectLock} from "./lock.js";
import {fromRelative, normalizeRelative} from "./paths.js";
import type {OpenProject} from "./project.js";

export interface CreateVersionInput {
  message?: string;
  direction?: string;
  kind?: VersionKind;
  principalId?: string;
  onBehalfOf?: string;
}

export async function createVersion(project: OpenProject, input: CreateVersionInput = {}): Promise<VersionRecord> {
  const lock = await acquireProjectLock(project.metaRoot);
  const operationId = newId("op");
  const journalPath = path.join(project.metaRoot, "journal", `${operationId}.json`);
  try {
    const packageId = newId("pkg");
    const versionId = newId("avv");
    const direction = input.direction?.trim() || project.descriptor.defaultDirection;
    const packagePath = path.join(project.metaRoot, "manifests", "packages", `${packageId}.json`);
    const versionPath = path.join(project.metaRoot, "manifests", "versions", `${versionId}.json`);
    await atomicWriteJson(journalPath, {schema: "avlab.journal/0.1", type: "save", operationId, versionPath: path.relative(project.metaRoot, versionPath)});

    const entries: PackageEntry[] = [];
    let totalBytes = 0;
    let uniqueBytesWritten = 0;
    for (const include of project.descriptor.includePaths) {
      const absolute = fromRelative(project.root, include);
      const relative = normalizeRelative(include);
      const scanned = await scanPath(project, absolute, relative === "." ? "" : relative);
      entries.push(...scanned.entries);
      totalBytes += scanned.totalBytes;
      uniqueBytesWritten += scanned.uniqueBytesWritten;
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: PackageManifest = {
      schema: "avlab.package/0.1",
      packageId,
      projectId: project.descriptor.projectId,
      createdAt: new Date().toISOString(),
      entries,
      totalBytes,
      uniqueBytesWritten
    };
    await atomicWriteJson(packagePath, manifest);

    const parent = project.database.getHead(direction);
    const createdBy: VersionRecord["createdBy"] = {principalId: input.principalId ?? "local-human"};
    if (input.onBehalfOf) createdBy.onBehalfOf = input.onBehalfOf;
    const record: VersionRecord = {
      schema: "avlab.version/0.1",
      versionId,
      projectId: project.descriptor.projectId,
      parentVersionIds: parent ? [parent] : [],
      direction,
      kind: input.kind ?? "named",
      message: input.message?.trim() || (input.kind === "recovery" ? "Automatic recovery point" : "Saved version"),
      createdAt: manifest.createdAt,
      createdBy,
      packageId,
      manifestPath: path.relative(project.metaRoot, packagePath).split(path.sep).join("/")
    };
    await atomicWriteJson(versionPath, record);
    project.database.addVersion(record);
    await rm(journalPath, {force: true});
    return record;
  } finally {
    await releaseProjectLock(lock);
  }
}

async function scanPath(project: OpenProject, absolute: string, relative: string): Promise<{entries: PackageEntry[]; totalBytes: number; uniqueBytesWritten: number}> {
  const info = await lstat(absolute);
  const projectRelative = normalizeRelative(relative || ".");
  if (info.isSymbolicLink()) {
    return {entries: [{path: projectRelative, kind: "symlink", mode: info.mode & 0o777, mtimeMs: info.mtimeMs, linkTarget: await readlink(absolute)}], totalBytes: 0, uniqueBytesWritten: 0};
  }
  if (info.isDirectory()) {
    const entries: PackageEntry[] = [];
    let totalBytes = 0, uniqueBytesWritten = 0;
    if (relative) entries.push({path: projectRelative, kind: "directory", mode: info.mode & 0o777, mtimeMs: info.mtimeMs});
    const children = (await readdir(absolute)).sort();
    for (const child of children) {
      if (!relative && child === ".avlab") continue;
      const childRelative = relative ? `${relative}/${child}` : child;
      const result = await scanPath(project, path.join(absolute, child), childRelative);
      entries.push(...result.entries);
      totalBytes += result.totalBytes;
      uniqueBytesWritten += result.uniqueBytesWritten;
    }
    return {entries, totalBytes, uniqueBytesWritten};
  }
  if (!info.isFile()) return {entries: [], totalBytes: 0, uniqueBytesWritten: 0};

  const chunks: ChunkRef[] = [];
  let uniqueBytesWritten = 0;
  const file = await chunkFile(absolute, async produced => {
    const result = await project.store.put(produced.contentId, produced.data);
    uniqueBytesWritten += result.bytes;
    chunks.push({contentId: produced.contentId, size: produced.data.length, offset: produced.offset});
  });
  const after = await lstat(absolute);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    throw new AvlabError("AVLAB_FILE_CHANGED_DURING_SAVE", `“${projectRelative}” changed while AVlab was saving it. Let the editor finish writing, then save the version again.`);
  }
  return {
    entries: [{
      path: projectRelative,
      kind: "file",
      mode: info.mode & 0o777,
      mtimeMs: info.mtimeMs,
      size: file.size,
      contentId: file.contentId,
      chunks
    }],
    totalBytes: file.size,
    uniqueBytesWritten
  };
}
