import {mkdir, open, readFile, rm, stat} from "node:fs/promises";
import path from "node:path";
import {AvlabError} from "./errors.js";

export async function acquireProjectLock(metaRoot: string): Promise<string> {
  const lockPath = path.join(metaRoot, "locks", "project.lock");
  await mkdir(path.dirname(lockPath), {recursive: true});
  const existing = await stat(lockPath).catch(() => undefined);
  if (existing && Date.now() - existing.mtimeMs > 30 * 60_000) {
    const lockData = JSON.parse(await readFile(lockPath, "utf8").catch(() => "{}")) as {pid?: number};
    let active = false;
    if (typeof lockData.pid === "number") {
      try { process.kill(lockData.pid, 0); active = true; }
      catch { active = false; }
    }
    if (!active) await rm(lockPath, {force: true});
  }
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({pid: process.pid, createdAt: new Date().toISOString()}));
    await handle.sync();
    await handle.close();
    return lockPath;
  } catch (error: unknown) {
    const details = await readFile(lockPath, "utf8").catch(() => "");
    throw new AvlabError("AVLAB_PROJECT_BUSY", "AVlab is already working on this project. Let that operation finish before trying again.", details || error);
  }
}

export async function releaseProjectLock(lockPath: string): Promise<void> {
  await rm(lockPath, {force: true});
}
