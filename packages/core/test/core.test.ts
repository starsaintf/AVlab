import {afterEach, describe, expect, it} from "vitest";
import {mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileObjectStore,
  compareVersions,
  createVersion,
  initProject,
  openProject,
  readPackageManifest,
  replicateObjects,
  restoreVersion,
  verifyProject
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "avlab-test-"));
  roots.push(root);
  return root;
}

describe("universal local versions", () => {
  it("saves, compares and restores a single native file without touching siblings", async () => {
    const root = await tempRoot();
    const projectFile = path.join(root, "song.flp");
    const notes = path.join(root, "notes.txt");
    await writeFile(projectFile, Buffer.from([0, 1, 2, 3, 4]));
    await writeFile(notes, "unrelated");
    const project = await initProject(projectFile, "Song");
    const v1 = await createVersion(project, {message: "Original beat"});
    await writeFile(projectFile, Buffer.from([9, 8, 7, 6]));
    const v2 = await createVersion(project, {message: "Changed drums"});
    const comparison = await compareVersions(project, v1.versionId, v2.versionId);
    expect(comparison.changes).toEqual([expect.objectContaining({path: "song.flp", change: "modified"})]);
    await restoreVersion(project, v1.versionId);
    expect([...await readFile(projectFile)]).toEqual([0, 1, 2, 3, 4]);
    expect(await readFile(notes, "utf8")).toBe("unrelated");
    project.database.close();
  });

  it("preserves nested files, empty directories and symbolic links", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "Audio"), {recursive: true});
    await mkdir(path.join(root, "Empty"), {recursive: true});
    await writeFile(path.join(root, "project.unknown"), "native bytes");
    await writeFile(path.join(root, "Audio", "take.wav"), Buffer.alloc(1024, 7));
    await symlink("Audio/take.wav", path.join(root, "latest-take"));
    const project = await initProject(root);
    const version = await createVersion(project, {message: "Complete package"});
    await rm(path.join(root, "Audio"), {recursive: true});
    await rm(path.join(root, "Empty"), {recursive: true});
    await rm(path.join(root, "latest-take"));
    await writeFile(path.join(root, "new.tmp"), "should disappear");
    await restoreVersion(project, version.versionId);
    expect(await readFile(path.join(root, "project.unknown"), "utf8")).toBe("native bytes");
    expect((await stat(path.join(root, "Empty"))).isDirectory()).toBe(true);
    expect((await stat(path.join(root, "latest-take"))).size).toBe(1024);
    await expect(stat(path.join(root, "new.tmp"))).rejects.toThrow();
    project.database.close();
  });
});

describe("large-media object storage", () => {
  it("deduplicates identical multi-megabyte media across files and versions", async () => {
    const root = await tempRoot();
    const media = Buffer.alloc(5 * 1024 * 1024, 0x5a);
    await writeFile(path.join(root, "take-a.wav"), media);
    await writeFile(path.join(root, "take-b.wav"), media);
    const project = await initProject(root);
    const v1 = await createVersion(project, {message: "Two duplicate takes"});
    const manifest1 = await readPackageManifest(project, v1);
    expect(manifest1.totalBytes).toBe(media.length * 2);
    expect(manifest1.uniqueBytesWritten).toBeLessThanOrEqual(media.length);
    await writeFile(path.join(root, "take-c.wav"), media);
    const v2 = await createVersion(project, {message: "Reused take"});
    const manifest2 = await readPackageManifest(project, v2);
    expect(manifest2.uniqueBytesWritten).toBe(0);
    project.database.close();
  });

  it("resumes a partial storage copy and verifies content", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "film.mov"), Buffer.alloc(3 * 1024 * 1024, 13));
    const project = await initProject(root);
    await createVersion(project, {message: "Film"});
    const [firstId] = await project.store.listContentIds();
    expect(firstId).toBeTruthy();
    const targetRoot = path.join(await tempRoot(), "objects");
    const target = new FileObjectStore(targetRoot);
    await target.init();
    const targetPath = target.objectPath(firstId!);
    await mkdir(path.dirname(targetPath), {recursive: true});
    const source = await readFile(project.store.objectPath(firstId!));
    await writeFile(`${targetPath}.part`, source.subarray(0, Math.floor(source.length / 2)));
    const result = await replicateObjects(project, targetRoot);
    expect(result.copied).toBeGreaterThan(0);
    expect((await readFile(targetPath)).equals(source)).toBe(true);
    project.database.close();
  });

  it("rejects a corrupted resumed storage copy", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "source.wav"), Buffer.alloc(1024 * 1024, 31));
    const project = await initProject(root);
    await createVersion(project, {message: "Source"});
    const [contentId] = await project.store.listContentIds();
    const targetRoot = path.join(await tempRoot(), "objects");
    const target = new FileObjectStore(targetRoot);
    await target.init();
    const targetPath = target.objectPath(contentId!);
    await mkdir(path.dirname(targetPath), {recursive: true});
    await writeFile(`${targetPath}.part`, Buffer.alloc(128, 99));
    await expect(replicateObjects(project, targetRoot)).rejects.toThrow(/integrity/i);
    project.database.close();
  });

  it("refuses restoration when stored media is corrupt", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "mix.wav"), Buffer.alloc(1024 * 1024, 22));
    const project = await initProject(root);
    const version = await createVersion(project, {message: "Mix"});
    const manifest = await readPackageManifest(project, version);
    const chunkId = manifest.entries.find(entry => entry.kind === "file")!.chunks![0]!.contentId;
    await writeFile(project.store.objectPath(chunkId), "corrupt");
    const result = await verifyProject(project);
    expect(result.ok).toBe(false);
    expect(result.corrupt).toContain(chunkId);
    await expect(restoreVersion(project, version.versionId)).rejects.toThrow(/integrity|unavailable|restore/i);
    project.database.close();
  });
});

describe("crash recovery", () => {
  it("finishes a saved version whose metadata commit was interrupted", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "session.ptx"), "session");
    const project = await initProject(root);
    const version = await createVersion(project, {message: "Session"});
    project.database.db.prepare("DELETE FROM heads").run();
    project.database.db.prepare("DELETE FROM versions WHERE version_id = ?").run(version.versionId);
    const versionPath = path.join("manifests", "versions", `${version.versionId}.json`);
    await writeFile(path.join(project.metaRoot, "journal", "interrupted.json"), JSON.stringify({type: "save", versionPath}));
    project.database.close();
    const recovered = await openProject(root);
    expect(recovered.database.getVersion(version.versionId)?.message).toBe("Session");
    recovered.database.close();
  });

  it("rolls back an interrupted restore instead of leaving a half-restored project", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "edit.prproj"), "current-work");
    const project = await initProject(root);
    const operationRoot = path.join(project.metaRoot, "tmp", "restore-crash");
    const stage = path.join(operationRoot, "stage");
    const backup = path.join(operationRoot, "backup");
    await mkdir(stage, {recursive: true});
    await mkdir(backup, {recursive: true});
    await writeFile(path.join(stage, "edit.prproj"), "older-version");
    await rename(path.join(root, "edit.prproj"), path.join(backup, "edit.prproj"));
    await writeFile(path.join(root, "edit.prproj"), "partial-restore");
    await writeFile(path.join(project.metaRoot, "journal", "restore-crash.json"), JSON.stringify({type: "restore", stage, backup}));
    project.database.close();
    const recovered = await openProject(root);
    expect(await readFile(path.join(root, "edit.prproj"), "utf8")).toBe("current-work");
    recovered.database.close();
  });
});
