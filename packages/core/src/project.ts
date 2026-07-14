import {lstat, mkdir, readFile, readdir, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import type {ProjectDescriptor} from "@avlab/contracts";
import {ProjectDatabase} from "./database.js";
import {AvlabError} from "./errors.js";
import {newId} from "./ids.js";
import {atomicWriteJson} from "./json.js";
import {FileObjectStore} from "./store.js";

export interface ProjectSettings {
  schema: "avlab.settings/0.1";
  objectStorePath: string;
  quotaBytes?: number;
  recoveryMinutes: number;
}

export interface OpenProject {
  root: string;
  metaRoot: string;
  descriptor: ProjectDescriptor;
  settings: ProjectSettings;
  database: ProjectDatabase;
  store: FileObjectStore;
}

export async function initProject(target: string, name?: string): Promise<OpenProject> {
  const absoluteTarget = path.resolve(target);
  const targetInfo = await lstat(absoluteTarget).catch(() => undefined);
  if (!targetInfo) throw new AvlabError("AVLAB_TARGET_NOT_FOUND", `Project path does not exist: ${absoluteTarget}`);
  const root = targetInfo.isDirectory() ? absoluteTarget : path.dirname(absoluteTarget);
  const rootKind = targetInfo.isDirectory() ? "directory" : "single-file";
  const includePaths = targetInfo.isDirectory() ? ["."] : [path.basename(absoluteTarget)];
  const metaRoot = path.join(root, ".avlab");
  if (await lstat(path.join(metaRoot, "project.json")).catch(() => undefined)) {
    throw new AvlabError("AVLAB_ALREADY_INITIALIZED", "This project is already connected to AVlab.");
  }
  for (const directory of [metaRoot, "manifests/packages", "manifests/versions", "objects", "tmp", "journal", "locks", "previews"])
    await mkdir(path.join(metaRoot, directory === metaRoot ? "" : directory), {recursive: true});

  const descriptor: ProjectDescriptor = {
    schema: "avlab.project/0.1",
    projectId: newId("avp"),
    name: name?.trim() || path.basename(absoluteTarget),
    createdAt: new Date().toISOString(),
    rootKind,
    includePaths,
    defaultDirection: "main",
    capabilityLevel: "U0",
    extensions: {}
  };
  const settings: ProjectSettings = {
    schema: "avlab.settings/0.1",
    objectStorePath: ".avlab/objects",
    recoveryMinutes: 5
  };
  await atomicWriteJson(path.join(metaRoot, "project.json"), descriptor);
  await atomicWriteJson(path.join(metaRoot, "settings.json"), settings);
  await writeFile(path.join(metaRoot, ".gitignore"), "*\n!.gitignore\n", "utf8");
  const database = new ProjectDatabase(path.join(metaRoot, "local.db"));
  const store = new FileObjectStore(resolveStorePath(root, settings), settings.quotaBytes);
  await store.init();
  return {root, metaRoot, descriptor, settings, database, store};
}

export async function openProject(target: string): Promise<OpenProject> {
  const root = await findProjectRoot(path.resolve(target));
  const metaRoot = path.join(root, ".avlab");
  const descriptor = JSON.parse(await readFile(path.join(metaRoot, "project.json"), "utf8")) as ProjectDescriptor;
  const settings = JSON.parse(await readFile(path.join(metaRoot, "settings.json"), "utf8")) as ProjectSettings;
  const database = new ProjectDatabase(path.join(metaRoot, "local.db"));
  const store = new FileObjectStore(resolveStorePath(root, settings), settings.quotaBytes);
  await store.init();
  const project = {root, metaRoot, descriptor, settings, database, store};
  await recoverIncompleteOperations(project);
  return project;
}

export async function setStorage(project: OpenProject, location: string, quotaBytes?: number): Promise<void> {
  const next: ProjectSettings = {...project.settings, objectStorePath: path.resolve(location)};
  if (quotaBytes !== undefined) next.quotaBytes = quotaBytes;
  await atomicWriteJson(path.join(project.metaRoot, "settings.json"), next);
}

async function findProjectRoot(start: string): Promise<string> {
  let current = (await lstat(start).catch(() => undefined))?.isDirectory() ? start : path.dirname(start);
  while (true) {
    if (await lstat(path.join(current, ".avlab", "project.json")).catch(() => undefined)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new AvlabError("AVLAB_NOT_INITIALIZED", "This folder is not connected to AVlab yet.");
}

function resolveStorePath(root: string, settings: ProjectSettings): string {
  return path.isAbsolute(settings.objectStorePath) ? settings.objectStorePath : path.resolve(root, settings.objectStorePath);
}

async function recoverIncompleteOperations(project: OpenProject): Promise<void> {
  const journalRoot = path.join(project.metaRoot, "journal");
  const files = await readdir(journalRoot).catch(() => [] as string[]);
  for (const file of files.filter(item => item.endsWith(".json"))) {
    const journalPath = path.join(journalRoot, file);
    try {
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {type: string; versionPath?: string; stage?: string; backup?: string};
      if (journal.type === "save" && journal.versionPath) {
        const record = JSON.parse(await readFile(path.join(project.metaRoot, journal.versionPath), "utf8")) as import("@avlab/contracts").VersionRecord;
        if (!project.database.hasVersion(record.versionId)) project.database.addVersion(record);
      }
      if (journal.type === "restore" && journal.stage && journal.backup) {
        await recoverRestore(project, journal.stage, journal.backup);
      }
      await rm(journalPath, {force: true});
    } catch {
      // Keep unreadable journals for manual diagnosis rather than deleting evidence.
    }
  }
}

async function recoverRestore(project: OpenProject, stage: string, backup: string): Promise<void> {
  const tempRoot = path.resolve(project.metaRoot, "tmp");
  const stageResolved = path.resolve(stage);
  const backupResolved = path.resolve(backup);
  if (!stageResolved.startsWith(`${tempRoot}${path.sep}`) || !backupResolved.startsWith(`${tempRoot}${path.sep}`)) return;
  const backupEntries = await readdir(backupResolved).catch(() => [] as string[]);
  if (backupEntries.length > 0) {
    if (project.descriptor.rootKind === "directory") {
      for (const name of await readdir(project.root)) if (name !== ".avlab") await rm(path.join(project.root, name), {recursive: true, force: true});
    } else {
      for (const include of project.descriptor.includePaths) await rm(path.resolve(project.root, include), {recursive: true, force: true});
    }
    for (const name of backupEntries) await rename(path.join(backupResolved, name), path.join(project.root, name));
  }
  await rm(path.dirname(stageResolved), {recursive: true, force: true});
}
