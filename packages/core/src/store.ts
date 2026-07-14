import {createReadStream, createWriteStream} from "node:fs";
import {createHash} from "node:crypto";
import {access, mkdir, open, readFile, readdir, rename, rm, stat} from "node:fs/promises";
import path from "node:path";
import {pipeline} from "node:stream/promises";
import {AvlabError} from "./errors.js";

export interface PutResult {written: boolean; bytes: number;}

export class FileObjectStore {
  private countedBytes: number | undefined;
  constructor(public readonly root: string, private readonly quotaBytes?: number) {}

  async init(): Promise<void> { await mkdir(path.join(this.root, "sha256"), {recursive: true}); }

  objectPath(contentId: string): string {
    const [algorithm, digest] = contentId.split(":");
    if (algorithm !== "sha256" || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new AvlabError("AVLAB_BAD_CONTENT_ID", `Invalid content identifier: ${contentId}`);
    }
    return path.join(this.root, algorithm, digest.slice(0, 2), digest);
  }

  async has(contentId: string): Promise<boolean> {
    try { await access(this.objectPath(contentId)); return true; } catch { return false; }
  }

  async put(contentId: string, data: Buffer): Promise<PutResult> {
    const destination = this.objectPath(contentId);
    if (await this.has(contentId)) return {written: false, bytes: 0};
    if (this.quotaBytes !== undefined) {
      this.countedBytes ??= await this.totalBytes();
      if (this.countedBytes + data.length > this.quotaBytes) {
        throw new AvlabError("AVLAB_STORAGE_FULL", "The selected AVlab storage location does not have enough allowed space.");
      }
    }
    await mkdir(path.dirname(destination), {recursive: true});
    const temp = `${destination}.${process.pid}.${Date.now()}.part`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temp, destination); }
    catch (error: unknown) {
      if (await this.has(contentId)) await rm(temp, {force: true});
      else throw error;
    }
    if (this.countedBytes !== undefined) this.countedBytes += data.length;
    return {written: true, bytes: data.length};
  }

  async materialize(contentIds: {contentId: string; size: number}[], destination: string): Promise<void> {
    await mkdir(path.dirname(destination), {recursive: true});
    const temp = `${destination}.${process.pid}.part`;
    const output = await open(temp, "w", 0o600);
    try {
      let position = 0;
      for (const chunk of contentIds) {
        const source = this.objectPath(chunk.contentId);
        const info = await stat(source).catch(() => undefined);
        if (!info || info.size !== chunk.size) throw new AvlabError("AVLAB_OBJECT_MISSING", `A required project piece is unavailable: ${chunk.contentId}`);
        const data = await readFile(source);
        const actualId = `sha256:${createHash("sha256").update(data).digest("hex")}`;
        if (actualId !== chunk.contentId) throw new AvlabError("AVLAB_OBJECT_CORRUPT", `A stored project piece failed its integrity check: ${chunk.contentId}`);
        await output.write(data, 0, data.length, position);
        position += data.length;
      }
      await output.sync();
    } catch (error) {
      await output.close().catch(() => undefined);
      await rm(temp, {force: true});
      throw error;
    }
    await output.close();
    await rename(temp, destination);
  }

  async listContentIds(): Promise<string[]> {
    const base = path.join(this.root, "sha256");
    const output: string[] = [];
    for (const prefix of await readdir(base).catch(() => [] as string[])) {
      for (const digest of await readdir(path.join(base, prefix)).catch(() => [] as string[])) {
        if (/^[a-f0-9]{64}$/.test(digest)) output.push(`sha256:${digest}`);
      }
    }
    return output;
  }

  async totalBytes(): Promise<number> {
    let total = 0;
    for (const id of await this.listContentIds()) total += (await stat(this.objectPath(id))).size;
    return total;
  }

  async remove(contentId: string): Promise<void> { await rm(this.objectPath(contentId), {force: true}); }

  async replicateTo(target: FileObjectStore): Promise<{copied: number; skipped: number}> {
    await target.init();
    let copied = 0, skipped = 0;
    for (const contentId of await this.listContentIds()) {
      if (await target.has(contentId)) { skipped++; continue; }
      const source = this.objectPath(contentId);
      const destination = target.objectPath(contentId);
      await mkdir(path.dirname(destination), {recursive: true});
      const partial = `${destination}.part`;
      const sourceSize = (await stat(source)).size;
      let existing = (await stat(partial).catch(() => ({size: 0}))).size;
      if (existing > sourceSize) { await rm(partial, {force: true}); existing = 0; }
      const output = createWriteStream(partial, {flags: existing > 0 ? "a" : "w", mode: 0o600});
      await pipeline(createReadStream(source, {start: existing}), output);
      if ((await stat(partial)).size !== sourceSize) throw new AvlabError("AVLAB_COPY_INCOMPLETE", `Could not finish copying ${contentId}`);
      const copiedBytes = await readFile(partial);
      const copiedId = `sha256:${createHash("sha256").update(copiedBytes).digest("hex")}`;
      if (copiedId !== contentId) {
        await rm(partial, {force: true});
        throw new AvlabError("AVLAB_COPY_CORRUPT", `The resumed copy failed its integrity check: ${contentId}`);
      }
      await rename(partial, destination);
      copied++;
    }
    return {copied, skipped};
  }
}
