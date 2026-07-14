import {lstat, readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";
import type {PackageManifest, StorageStatus} from "@avlab/contracts";
import type {OpenProject} from "./project.js";
import {FileObjectStore} from "./store.js";

export async function storageStatus(project: OpenProject): Promise<StorageStatus> {
  const all = await project.store.listContentIds();
  const reachable = await reachableContentIds(project);
  const missingObjects: string[] = [];
  let storedBytes = 0, reachableBytes = 0;
  for (const id of all) storedBytes += (await stat(project.store.objectPath(id))).size;
  for (const id of reachable) {
    const info = await stat(project.store.objectPath(id)).catch(() => undefined);
    if (!info) missingObjects.push(id); else reachableBytes += info.size;
  }
  return {objectCount: all.length, storedBytes, reachableObjectCount: reachable.size, reachableBytes, missingObjects};
}

export async function garbageCollect(project: OpenProject): Promise<{removedObjects: number; removedBytes: number}> {
  const reachable = await reachableContentIds(project);
  let removedObjects = 0, removedBytes = 0;
  for (const id of await project.store.listContentIds()) {
    if (reachable.has(id)) continue;
    removedBytes += (await stat(project.store.objectPath(id))).size;
    await project.store.remove(id);
    removedObjects++;
  }
  return {removedObjects, removedBytes};
}

export async function verifyProject(project: OpenProject): Promise<{ok: boolean; missing: string[]; corrupt: string[]}> {
  const reachable = await reachableContentIds(project);
  const missing: string[] = [], corrupt: string[] = [];
  const {createHash} = await import("node:crypto");
  const {createReadStream} = await import("node:fs");
  for (const id of reachable) {
    const objectPath = project.store.objectPath(id);
    if (!(await lstat(objectPath).catch(() => undefined))) { missing.push(id); continue; }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(objectPath)) digest.update(chunk as Buffer);
    if (`sha256:${digest.digest("hex")}` !== id) corrupt.push(id);
  }
  return {ok: missing.length === 0 && corrupt.length === 0, missing, corrupt};
}

export async function replicateObjects(project: OpenProject, targetPath: string): Promise<{copied: number; skipped: number}> {
  const target = new FileObjectStore(path.resolve(targetPath));
  return project.store.replicateTo(target);
}

async function reachableContentIds(project: OpenProject): Promise<Set<string>> {
  const result = new Set<string>();
  const root = path.join(project.metaRoot, "manifests", "packages");
  for (const file of await readdir(root).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    const manifest = JSON.parse(await readFile(path.join(root, file), "utf8")) as PackageManifest;
    for (const entry of manifest.entries) for (const chunk of entry.chunks ?? []) result.add(chunk.contentId);
  }
  return result;
}
