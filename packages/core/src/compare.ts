import type {CompareResult, FileChange, PackageEntry} from "@avlab/contracts";
import {readPackageManifest, requireVersion} from "./manifests.js";
import type {OpenProject} from "./project.js";

export async function compareVersions(project: OpenProject, fromVersionId: string, toVersionId: string): Promise<CompareResult> {
  const before = await readPackageManifest(project, requireVersion(project, fromVersionId));
  const after = await readPackageManifest(project, requireVersion(project, toVersionId));
  const beforeMap = new Map(before.entries.map(entry => [entry.path, entry]));
  const afterMap = new Map(after.entries.map(entry => [entry.path, entry]));
  const changes: FileChange[] = [];
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  for (const itemPath of paths) {
    const left = beforeMap.get(itemPath);
    const right = afterMap.get(itemPath);
    if (!left && right) changes.push({path: itemPath, change: "added", ...(right.contentId ? {afterContentId: right.contentId} : {})});
    else if (left && !right) changes.push({path: itemPath, change: "removed", ...(left.contentId ? {beforeContentId: left.contentId} : {})});
    else if (left && right) {
      if (materiallyDifferent(left, right)) changes.push({path: itemPath, change: "modified", ...(left.contentId ? {beforeContentId: left.contentId} : {}), ...(right.contentId ? {afterContentId: right.contentId} : {})});
      else if (left.mode !== right.mode || left.mtimeMs !== right.mtimeMs) changes.push({path: itemPath, change: "metadata"});
    }
  }
  return {fromVersionId, toVersionId, changes};
}

function materiallyDifferent(a: PackageEntry, b: PackageEntry): boolean {
  return a.kind !== b.kind || a.contentId !== b.contentId || a.linkTarget !== b.linkTarget || a.size !== b.size;
}
