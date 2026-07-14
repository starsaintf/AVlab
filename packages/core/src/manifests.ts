import {readFile} from "node:fs/promises";
import path from "node:path";
import type {PackageManifest, VersionRecord} from "@avlab/contracts";
import {AvlabError} from "./errors.js";
import type {OpenProject} from "./project.js";

export async function readPackageManifest(project: OpenProject, version: VersionRecord): Promise<PackageManifest> {
  const full = path.resolve(project.metaRoot, ...version.manifestPath.split("/"));
  if (!full.startsWith(path.resolve(project.metaRoot) + path.sep)) throw new AvlabError("AVLAB_UNSAFE_MANIFEST", "The version points outside its AVlab workspace.");
  return JSON.parse(await readFile(full, "utf8")) as PackageManifest;
}

export function requireVersion(project: OpenProject, versionId: string): VersionRecord {
  const version = project.database.getVersion(versionId);
  if (!version) throw new AvlabError("AVLAB_VERSION_NOT_FOUND", `Saved version not found: ${versionId}`);
  return version;
}
