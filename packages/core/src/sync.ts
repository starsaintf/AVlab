import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import type {
  PackageManifest,
  PreviewRecord,
  ProjectDescriptor,
  RemoteRecord,
  ReviewRecord,
  SyncConflict,
  SyncReceipt,
  SyncResult,
  VersionRecord
} from "@avlab/contracts";
import {AvlabError} from "./errors.js";
import {newId} from "./ids.js";
import {atomicWriteJson} from "./json.js";
import {readPackageManifest} from "./manifests.js";
import {initProject, openProject, type OpenProject} from "./project.js";
import {previewPath} from "./preview.js";
import {restoreVersion} from "./restore.js";

const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;

interface RemoteSnapshot {
  project: ProjectDescriptor;
  versions: Array<{version: VersionRecord; packageManifest: PackageManifest; previews: PreviewRecord[]}>;
  objectIds: string[];
  heads?: Record<string, string>;
}

export function configureRemote(project: OpenProject, name: string, url: string, token: string): RemoteRecord {
  const remote: RemoteRecord = {
    schema: "avlab.remote/0.1",
    name: name.trim() || "origin",
    url: url.replace(/\/+$/, ""),
    token,
    createdAt: new Date().toISOString()
  };
  project.database.addRemote(remote);
  return {...remote, token: "***"};
}

export function listRemotes(project: OpenProject): Array<Omit<RemoteRecord, "token"> & {token: string}> {
  return project.database.listRemotes().map(remote => ({...remote, token: "***"}));
}

export function listSyncReceipts(project: OpenProject): SyncReceipt[] {
  return project.database.listSyncReceipts();
}

export function listSyncConflicts(project: OpenProject, includeResolved = false): SyncConflict[] {
  return project.database.listSyncConflicts(includeResolved);
}

export function resolveSyncConflict(project: OpenProject, conflictId: string, chosenVersionId: string): SyncConflict {
  const conflict = project.database.listSyncConflicts(true).find(item => item.conflictId === conflictId);
  if (!conflict) throw new AvlabError("AVLAB_SYNC_CONFLICT_NOT_FOUND", `Sync conflict not found: ${conflictId}`);
  if (![conflict.localHeadVersionId, conflict.remoteHeadVersionId].includes(chosenVersionId)) {
    throw new AvlabError("AVLAB_SYNC_CONFLICT_CHOICE", "Choose either the local or remote saved version for this conflict.");
  }
  project.database.setHead(conflict.direction, chosenVersionId);
  return project.database.resolveSyncConflict(conflictId)!;
}

export async function pushRemote(project: OpenProject, name = "origin"): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const remote = requireRemote(project, name);
  const versions = project.database.listVersions(true);
  const versionBundles = await Promise.all(versions.map(async version => ({
    version,
    packageManifest: await readPackageManifest(project, version),
    previews: project.database.listPreviews(version.versionId)
  })));
  const objectIds = [...new Set(versionBundles.flatMap(bundle => bundle.packageManifest.entries.flatMap(entry => (entry.chunks ?? []).map(chunk => chunk.contentId))))];
  const previewIds = versionBundles.flatMap(bundle => bundle.previews.map(preview => preview.previewId));
  const plan = await remoteJson<{missingObjectIds: string[]; missingVersionIds: string[]; missingPreviewIds: string[]}>(remote, "/api/sync/plan", {
    method: "POST",
    body: JSON.stringify({project: project.descriptor, objectIds, versionIds: versions.map(version => version.versionId), previewIds})
  });

  for (const contentId of plan.missingObjectIds) {
    const data = await readFile(project.store.objectPath(contentId));
    await uploadResumable(remote, `/api/objects/${encodeURIComponent(contentId)}`, data, "application/octet-stream");
  }
  for (const previewId of plan.missingPreviewIds) {
    const preview = project.database.getPreview(previewId);
    if (!preview) continue;
    const data = await readFile(previewPath(project, preview));
    await uploadResumable(remote, `/api/previews/${encodeURIComponent(previewId)}/content`, data, preview.mimeType);
  }
  for (const bundle of versionBundles.filter(item => plan.missingVersionIds.includes(item.version.versionId))) {
    await remoteJson(remote, `/api/projects/${encodeURIComponent(project.descriptor.projectId)}/versions`, {
      method: "POST", body: JSON.stringify(bundle)
    });
  }
  const result: SyncResult = {
    uploadedObjects: plan.missingObjectIds.length,
    downloadedObjects: 0,
    uploadedVersions: plan.missingVersionIds.length,
    downloadedVersions: 0,
    uploadedPreviews: plan.missingPreviewIds.length,
    downloadedPreviews: 0
  };
  const receipt = await publishReceipt(remote, project, name, "push", startedAt, result, []);
  project.database.addSyncReceipt(receipt);
  return {...result, receiptId: receipt.receiptId};
}

export async function pullRemote(project: OpenProject, name = "origin", options: {mode?: "metadata" | "proxies" | "full"} = {}): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const remote = requireRemote(project, name);
  const snapshot = await remoteJson<RemoteSnapshot>(remote, `/api/projects/${encodeURIComponent(project.descriptor.projectId)}/snapshot`);
  if (snapshot.project.projectId !== project.descriptor.projectId) throw new AvlabError("AVLAB_REMOTE_PROJECT_MISMATCH", "The remote project does not match this local project.");
  let downloadedObjects = 0, downloadedVersions = 0, downloadedPreviews = 0;
  const mode = options.mode ?? "full";
  const existingDirections = new Set(project.database.listVersions(true).map(version => version.direction));
  const localHeads = new Map<string, string>();
  for (const direction of existingDirections) {
    const head = project.database.getHead(direction);
    if (head) localHeads.set(direction, head);
  }

  for (const contentId of mode === "full" ? snapshot.objectIds : []) {
    if (await project.store.has(contentId)) continue;
    const data = await downloadResumable(remote, `/api/objects/${encodeURIComponent(contentId)}`);
    await project.store.put(contentId, data);
    downloadedObjects++;
  }
  for (const bundle of snapshot.versions) {
    const packagePath = path.join(project.metaRoot, "manifests", "packages", `${bundle.packageManifest.packageId}.json`);
    const versionPath = path.join(project.metaRoot, "manifests", "versions", `${bundle.version.versionId}.json`);
    await atomicWriteJson(packagePath, bundle.packageManifest);
    const localVersion: VersionRecord = {...bundle.version, manifestPath: path.relative(project.metaRoot, packagePath).split(path.sep).join("/")};
    await atomicWriteJson(versionPath, localVersion);
    if (!project.database.hasVersion(localVersion.versionId)) downloadedVersions++;
    project.database.upsertVersion(localVersion, false);
    for (const preview of mode === "metadata" ? [] : bundle.previews) {
      if (project.database.getPreview(preview.previewId) && await stat(previewPath(project, preview)).catch(() => undefined)) continue;
      const data = await downloadResumable(remote, `/api/previews/${encodeURIComponent(preview.previewId)}/content`);
      const {createHash} = await import("node:crypto");
      const actualId = `sha256:${createHash("sha256").update(data).digest("hex")}`;
      if (actualId !== preview.contentId) throw new AvlabError("AVLAB_PREVIEW_CORRUPT", `Downloaded preview failed its integrity check: ${preview.previewId}`);
      const destination = path.join(project.metaRoot, ...preview.relativePath.split("/"));
      await mkdir(path.dirname(destination), {recursive: true});
      await writeFile(destination, data);
      project.database.addPreview(preview);
      downloadedPreviews++;
    }
  }

  const remoteHeads = snapshot.heads ?? inferRemoteHeads(snapshot.versions.map(item => item.version));
  const conflicts: SyncConflict[] = [];
  for (const [direction, remoteHead] of Object.entries(remoteHeads)) {
    const localHead = localHeads.get(direction);
    if (!localHead) {
      project.database.setHead(direction, remoteHead);
      continue;
    }
    if (localHead === remoteHead || isAncestor(project, localHead, remoteHead)) {
      project.database.setHead(direction, remoteHead);
      continue;
    }
    if (isAncestor(project, remoteHead, localHead)) continue;
    const conflict: SyncConflict = {
      conflictId: newId("cnf"),
      projectId: project.descriptor.projectId,
      remoteName: name,
      direction,
      localHeadVersionId: localHead,
      remoteHeadVersionId: remoteHead,
      createdAt: new Date().toISOString()
    };
    project.database.addSyncConflict(conflict);
    conflicts.push(conflict);
  }

  const result: SyncResult = {uploadedObjects: 0, downloadedObjects, uploadedVersions: 0, downloadedVersions, uploadedPreviews: 0, downloadedPreviews, conflicts};
  const receipt = await publishReceipt(remote, project, name, "pull", startedAt, result, conflicts.map(item => item.conflictId));
  project.database.addSyncReceipt(receipt);
  return {...result, receiptId: receipt.receiptId};
}

export async function cloneRemoteProject(destination: string, remoteInput: {name?: string; url: string; token: string}, projectId: string): Promise<OpenProject> {
  const remote: RemoteRecord = {schema: "avlab.remote/0.1", name: remoteInput.name ?? "origin", url: remoteInput.url.replace(/\/+$/, ""), token: remoteInput.token, createdAt: new Date().toISOString()};
  const descriptor = await remoteJson<ProjectDescriptor>(remote, `/api/projects/${encodeURIComponent(projectId)}`);
  await mkdir(destination, {recursive: true});
  const initial = await initProject(destination, descriptor.name);
  await atomicWriteJson(path.join(initial.metaRoot, "project.json"), {...descriptor, rootKind: "directory", includePaths: ["."]});
  initial.database.close();
  const project = await openProject(destination);
  project.database.addRemote(remote);
  await pullRemote(project, remote.name);
  const head = project.database.getHead(project.descriptor.defaultDirection);
  if (head) await restoreVersion(project, head);
  return project;
}

export async function requestRemoteReview(project: OpenProject, input: {
  remoteName?: string;
  versionId: string;
  title?: string;
  requiredApprovals?: number;
  expiresAt?: string;
  permissions?: ReviewRecord["permissions"];
}): Promise<{review: ReviewRecord; reviewUrl: string}> {
  const remote = requireRemote(project, input.remoteName ?? "origin");
  await pushRemote(project, remote.name);
  return remoteJson(remote, `/api/projects/${encodeURIComponent(project.descriptor.projectId)}/reviews`, {
    method: "POST",
    body: JSON.stringify({versionId: input.versionId, title: input.title, requiredApprovals: input.requiredApprovals, expiresAt: input.expiresAt, permissions: input.permissions})
  });
}

export async function listRemoteReviews(project: OpenProject, remoteName = "origin"): Promise<ReviewRecord[]> {
  const remote = requireRemote(project, remoteName);
  const result = await remoteJson<{reviews: ReviewRecord[]}>(remote, `/api/projects/${encodeURIComponent(project.descriptor.projectId)}/reviews`);
  const statusMap = {approved: "approved", "changes-requested": "changes-requested", rejected: "rejected", open: "under-review", closed: "rejected"} as const;
  for (const proposal of project.database.listProposals()) {
    const review = result.reviews.find(item => item.reviewId === proposal.reviewId);
    if (review) project.database.addProposal({...proposal, status: statusMap[review.status]});
  }
  return result.reviews;
}

function requireRemote(project: OpenProject, name: string): RemoteRecord {
  const remote = project.database.getRemote(name);
  if (!remote) throw new AvlabError("AVLAB_REMOTE_NOT_FOUND", `Remote project home not found: ${name}`);
  return remote;
}

async function publishReceipt(
  remote: RemoteRecord,
  project: OpenProject,
  remoteName: string,
  operation: SyncReceipt["operation"],
  startedAt: string,
  result: SyncResult,
  conflictIds: string[]
): Promise<SyncReceipt> {
  const localReceipt: SyncReceipt = {
    receiptId: newId("syn"),
    projectId: project.descriptor.projectId,
    remoteName,
    operation,
    startedAt,
    completedAt: new Date().toISOString(),
    uploadedObjects: result.uploadedObjects,
    downloadedObjects: result.downloadedObjects,
    uploadedVersions: result.uploadedVersions,
    downloadedVersions: result.downloadedVersions,
    uploadedPreviews: result.uploadedPreviews,
    downloadedPreviews: result.downloadedPreviews,
    conflictIds
  };
  return await remoteJson<SyncReceipt>(remote, `/api/projects/${encodeURIComponent(project.descriptor.projectId)}/sync-receipts`, {
    method: "POST", body: JSON.stringify(localReceipt)
  }).catch(() => localReceipt);
}

async function uploadResumable(remote: RemoteRecord, route: string, data: Buffer, contentType: string): Promise<void> {
  if (data.length === 0) {
    await remoteFetch(remote, route, {method: "PUT", headers: {"content-type": contentType, "content-range": "bytes 0-0/0"}, body: new Uint8Array(data)}, [200, 201, 204]);
    return;
  }
  let start = 0;
  let retries = 0;
  while (start < data.length) {
    const end = Math.min(data.length, start + TRANSFER_CHUNK_BYTES) - 1;
    let response: Response;
    try {
      response = await remoteFetch(remote, route, {
        method: "PUT",
        headers: {"content-type": contentType, "content-range": `bytes ${start}-${end}/${data.length}`},
        body: new Uint8Array(data.subarray(start, end + 1))
      }, [200, 201, 204, 308, 409]);
    } catch (error) {
      if (++retries > 3) throw error;
      continue;
    }
    if (response.status === 409) {
      const expected = Number(response.headers.get("x-avlab-next-offset"));
      if (!Number.isInteger(expected) || expected < 0 || expected > data.length) throw new AvlabError("AVLAB_REMOTE_ERROR", "The remote returned an invalid resume offset.");
      start = expected;
      continue;
    }
    retries = 0;
    if (response.status === 308) {
      const expected = Number(response.headers.get("x-avlab-next-offset"));
      start = Number.isInteger(expected) && expected > start ? expected : end + 1;
      continue;
    }
    if (end < data.length - 1) throw new AvlabError("AVLAB_REMOTE_ERROR", "The remote ended a resumable upload before all pieces were sent.");
    start = data.length;
  }
}

async function downloadResumable(remote: RemoteRecord, route: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const response = await remoteFetch(remote, route, {headers: {range: `bytes=${offset}-${offset + TRANSFER_CHUNK_BYTES - 1}`}}, [200, 206]);
    const data = Buffer.from(await response.arrayBuffer());
    chunks.push(data);
    if (response.status === 200) break;
    const value = response.headers.get("content-range");
    const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!match) throw new AvlabError("AVLAB_REMOTE_ERROR", "The remote returned an invalid resumable download range.");
    const end = Number(match[2]), total = Number(match[3]);
    offset = end + 1;
    if (offset >= total) break;
  }
  return Buffer.concat(chunks);
}

function inferRemoteHeads(versions: VersionRecord[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const version of [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) result[version.direction] = version.versionId;
  return result;
}

function isAncestor(project: OpenProject, ancestorId: string, descendantId: string): boolean {
  if (ancestorId === descendantId) return true;
  const visited = new Set<string>();
  const queue = [descendantId];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const version = project.database.getVersion(current);
    if (!version) continue;
    if (version.parentVersionIds.includes(ancestorId)) return true;
    queue.push(...version.parentVersionIds);
  }
  return false;
}

async function remoteJson<T>(remote: RemoteRecord, route: string, init: RequestInit = {}): Promise<T> {
  const response = await remoteFetch(remote, route, {headers: {"content-type": "application/json", ...(init.headers ?? {})}, ...init});
  return await response.json() as T;
}

async function remoteFetch(remote: RemoteRecord, route: string, init: RequestInit = {}, acceptedStatuses?: number[]): Promise<Response> {
  const response = await fetch(`${remote.url}${route}`, {...init, headers: {authorization: `Bearer ${remote.token}`, ...(init.headers ?? {})}});
  if (!response.ok && !acceptedStatuses?.includes(response.status)) {
    const body = await response.json().catch(() => ({})) as {message?: string};
    throw new AvlabError("AVLAB_REMOTE_ERROR", body.message ?? `Remote returned ${response.status}.`);
  }
  return response;
}
