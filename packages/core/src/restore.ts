import {chmod, lstat, mkdir, readdir, rename, rm, symlink, utimes, writeFile} from "node:fs/promises";
import path from "node:path";
import type {PackageEntry} from "@avlab/contracts";
import {AvlabError} from "./errors.js";
import {newId} from "./ids.js";
import {atomicWriteJson} from "./json.js";
import {acquireProjectLock, releaseProjectLock} from "./lock.js";
import {readPackageManifest, requireVersion} from "./manifests.js";
import {fromRelative} from "./paths.js";
import type {OpenProject} from "./project.js";

export async function restoreVersion(project: OpenProject, versionId: string): Promise<void> {
  const lock = await acquireProjectLock(project.metaRoot);
  try {
    const version = requireVersion(project, versionId);
    const manifest = await readPackageManifest(project, version);
    const operationId = newId("op");
    const operationRoot = path.join(project.metaRoot, "tmp", `restore-${operationId}`);
    const stage = path.join(operationRoot, "stage");
    const backup = path.join(operationRoot, "backup");
    const journalPath = path.join(project.metaRoot, "journal", `${operationId}.json`);
    await mkdir(stage, {recursive: true});
    await mkdir(backup, {recursive: true});
    await atomicWriteJson(journalPath, {schema: "avlab.journal/0.1", type: "restore", operationId, stage, backup, versionId});

    try {
      for (const entry of manifest.entries.filter(item => item.kind === "directory")) await materializeEntry(project, stage, entry);
      for (const entry of manifest.entries.filter(item => item.kind !== "directory")) await materializeEntry(project, stage, entry);

      await moveCurrentToBackup(project, backup);
      try {
        await moveStageIntoProject(project, stage);
      } catch (error) {
        await removeCurrentScope(project);
        await moveBackupIntoProject(project, backup);
        throw error;
      }
      await rm(operationRoot, {recursive: true, force: true});
      await rm(journalPath, {force: true});
    } catch (error) {
      throw new AvlabError("AVLAB_RESTORE_FAILED", `AVlab could not restore the selected version: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  } finally {
    await releaseProjectLock(lock);
  }
}

async function materializeEntry(project: OpenProject, stage: string, entry: PackageEntry): Promise<void> {
  const destination = fromRelative(stage, entry.path);
  if (entry.kind === "directory") {
    await mkdir(destination, {recursive: true, mode: entry.mode});
  } else if (entry.kind === "symlink") {
    await mkdir(path.dirname(destination), {recursive: true});
    await symlink(entry.linkTarget!, destination);
  } else {
    await mkdir(path.dirname(destination), {recursive: true});
    const chunks = entry.chunks ?? [];
    if (chunks.length === 0) await writeFile(destination, Buffer.alloc(0), {mode: entry.mode});
    else await project.store.materialize(chunks, destination);
    if ((await lstat(destination)).size !== entry.size) throw new AvlabError("AVLAB_RESTORE_SIZE_MISMATCH", `Restored file size is incorrect: ${entry.path}`);
  }
  if (entry.kind !== "symlink") {
    await chmod(destination, entry.mode).catch(() => undefined);
    const time = new Date(entry.mtimeMs);
    await utimes(destination, time, time).catch(() => undefined);
  }
}

async function moveCurrentToBackup(project: OpenProject, backup: string): Promise<void> {
  if (project.descriptor.rootKind === "directory") {
    for (const name of await readdir(project.root)) {
      if (name === ".avlab") continue;
      await rename(path.join(project.root, name), path.join(backup, name));
    }
  } else {
    for (const include of project.descriptor.includePaths) {
      const source = fromRelative(project.root, include);
      if (await lstat(source).catch(() => undefined)) {
        const destination = fromRelative(backup, include);
        await mkdir(path.dirname(destination), {recursive: true});
        await rename(source, destination);
      }
    }
  }
}

async function moveStageIntoProject(project: OpenProject, stage: string): Promise<void> {
  for (const name of await readdir(stage)) await rename(path.join(stage, name), path.join(project.root, name));
}

async function moveBackupIntoProject(project: OpenProject, backup: string): Promise<void> {
  for (const name of await readdir(backup).catch(() => [] as string[])) await rename(path.join(backup, name), path.join(project.root, name));
}

async function removeCurrentScope(project: OpenProject): Promise<void> {
  if (project.descriptor.rootKind === "directory") {
    for (const name of await readdir(project.root)) if (name !== ".avlab") await rm(path.join(project.root, name), {recursive: true, force: true});
  } else {
    for (const include of project.descriptor.includePaths) await rm(fromRelative(project.root, include), {recursive: true, force: true});
  }
}
