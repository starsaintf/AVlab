import {cp, mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import type {PackageManifest, PreviewRecord, ProjectDescriptor, VersionRecord} from "@avlab/contracts";
import {AvlabError} from "./errors.js";
import {atomicWriteJson} from "./json.js";
import {initProject, openProject, type OpenProject} from "./project.js";
import {previewPath} from "./preview.js";
import {restoreVersion} from "./restore.js";
import {FileObjectStore} from "./store.js";

interface BundleIndex {
  schema: "avlab.bundle/0.1";
  project: ProjectDescriptor;
  versions: VersionRecord[];
  previews: PreviewRecord[];
  createdAt: string;
}

export async function exportProjectBundle(project: OpenProject, destination: string): Promise<{destination: string; versions: number; previews: number}> {
  const root = path.resolve(destination);
  await mkdir(root, {recursive: true});
  const versions = project.database.listVersions(true);
  const previews = project.database.listPreviews();
  const index: BundleIndex = {schema: "avlab.bundle/0.1", project: project.descriptor, versions, previews, createdAt: new Date().toISOString()};
  await atomicWriteJson(path.join(root, "bundle.json"), index);
  await mkdir(path.join(root, "manifests", "packages"), {recursive: true});
  await mkdir(path.join(root, "manifests", "versions"), {recursive: true});
  for (const version of versions) {
    const packageSource = path.resolve(project.metaRoot, ...version.manifestPath.split("/"));
    await cp(packageSource, path.join(root, "manifests", "packages", `${version.packageId}.json`));
    await atomicWriteJson(path.join(root, "manifests", "versions", `${version.versionId}.json`), version);
  }
  const targetStore = new FileObjectStore(path.join(root, "objects"));
  await project.store.replicateTo(targetStore);
  await mkdir(path.join(root, "previews"), {recursive: true});
  for (const preview of previews) await cp(previewPath(project, preview), path.join(root, "previews", `${preview.previewId}${path.extname(preview.relativePath)}`));
  return {destination: root, versions: versions.length, previews: previews.length};
}

export async function importProjectBundle(bundlePath: string, destination: string): Promise<OpenProject> {
  const bundleRoot = path.resolve(bundlePath);
  const index = JSON.parse(await readFile(path.join(bundleRoot, "bundle.json"), "utf8")) as BundleIndex;
  if (index.schema !== "avlab.bundle/0.1") throw new AvlabError("AVLAB_BAD_BUNDLE", "This folder is not a supported AVlab project bundle.");
  await mkdir(destination, {recursive: true});
  const initial = await initProject(destination, index.project.name);
  await atomicWriteJson(path.join(initial.metaRoot, "project.json"), {...index.project, rootKind: "directory", includePaths: ["."]});
  initial.database.close();
  const project = await openProject(destination);
  const bundleStore = new FileObjectStore(path.join(bundleRoot, "objects"));
  await bundleStore.replicateTo(project.store);
  for (const version of index.versions) {
    const packageSource = path.join(bundleRoot, "manifests", "packages", `${version.packageId}.json`);
    const packageDestination = path.join(project.metaRoot, "manifests", "packages", `${version.packageId}.json`);
    await cp(packageSource, packageDestination);
    const localVersion: VersionRecord = {...version, manifestPath: path.relative(project.metaRoot, packageDestination).split(path.sep).join("/")};
    await atomicWriteJson(path.join(project.metaRoot, "manifests", "versions", `${version.versionId}.json`), localVersion);
    project.database.upsertVersion(localVersion, true);
  }
  for (const preview of index.previews) {
    const candidates = (await readdir(path.join(bundleRoot, "previews"))).filter(name => name.startsWith(preview.previewId));
    const source = candidates[0] ? path.join(bundleRoot, "previews", candidates[0]) : undefined;
    if (!source || !(await stat(source).catch(() => undefined))) continue;
    const destinationPath = path.join(project.metaRoot, ...preview.relativePath.split("/"));
    await mkdir(path.dirname(destinationPath), {recursive: true});
    await cp(source, destinationPath);
    project.database.addPreview(preview);
  }
  const head = project.database.getHead(project.descriptor.defaultDirection);
  if (head) await restoreVersion(project, head);
  return project;
}
