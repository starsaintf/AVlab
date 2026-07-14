import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {copyFile, mkdir, readFile, rm, stat} from "node:fs/promises";
import path from "node:path";
import type {MediaKind, PackageEntry, PreviewMetadata, PreviewProfile, PreviewRecord, PreviewSource} from "@avlab/contracts";
import {AvlabError} from "./errors.js";
import {newId} from "./ids.js";
import {readPackageManifest, requireVersion} from "./manifests.js";
import type {OpenProject} from "./project.js";

const AUDIO = new Set([".wav", ".wave", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus"]);
const VIDEO = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".mxf", ".mts", ".m2ts"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff"]);

export interface PreviewToolOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  profile?: PreviewProfile;
  signal?: AbortSignal;
}

export interface GeneratePreviewOptions extends PreviewToolOptions {
  sourcePath?: string;
  maxDurationSeconds?: number;
}

export async function attachPreview(
  project: OpenProject,
  versionId: string,
  sourcePath: string,
  source: PreviewSource = "user-export",
  options: PreviewToolOptions = {}
): Promise<PreviewRecord> {
  requireVersion(project, versionId);
  const absolute = path.resolve(sourcePath);
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isFile()) throw new AvlabError("AVLAB_PREVIEW_NOT_FOUND", `Preview file not found: ${absolute}`);
  const extension = path.extname(absolute).toLowerCase() || ".bin";
  const previewId = newId("prv");
  const fileName = `${previewId}${extension}`;
  const relativePath = path.posix.join("previews", fileName);
  const destination = path.join(project.metaRoot, "previews", fileName);
  await mkdir(path.dirname(destination), {recursive: true});
  await copyFile(absolute, destination);
  const data = await readFile(destination);
  const mediaKind = classifyMedia(absolute);
  const metadata = await inspectMedia(destination, options.ffprobePath ?? "ffprobe", options.signal).catch(() => undefined);
  const artifacts = await createInspectionArtifacts(project, previewId, destination, mediaKind, options).catch(() => ({}));
  const record: PreviewRecord = {
    schema: "avlab.preview/0.1",
    previewId,
    projectId: project.descriptor.projectId,
    versionId,
    mediaKind,
    mimeType: mimeFor(absolute),
    fileName: path.basename(absolute),
    relativePath,
    source,
    ...(options.profile ? {profile: options.profile} : {}),
    size: data.length,
    contentId: `sha256:${createHash("sha256").update(data).digest("hex")}`,
    createdAt: new Date().toISOString(),
    ...(metadata?.durationMs !== undefined ? {durationMs: metadata.durationMs} : {}),
    ...(metadata ? {metadata} : {}),
    ...artifacts
  };
  project.database.addPreview(record);
  return record;
}

export async function generatePreview(project: OpenProject, versionId: string, options: GeneratePreviewOptions = {}): Promise<PreviewRecord> {
  const version = requireVersion(project, versionId);
  const manifest = await readPackageManifest(project, version);
  let candidate: PackageEntry | undefined;
  if (options.sourcePath) {
    const normalized = options.sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
    candidate = manifest.entries.find(entry => entry.kind === "file" && entry.path === normalized);
  } else {
    candidate = manifest.entries
      .filter(entry => entry.kind === "file" && entry.chunks)
      .sort((a, b) => previewPriority(a.path) - previewPriority(b.path) || (b.size ?? 0) - (a.size ?? 0))[0];
  }
  if (!candidate || !candidate.chunks) throw new AvlabError("AVLAB_NO_PREVIEW_SOURCE", "AVlab could not find playable audio, video or image media in this version. Export a preview from the editor and attach it instead.");
  const kind = classifyMedia(candidate.path);
  if (kind === "unknown") throw new AvlabError("AVLAB_NO_PREVIEW_SOURCE", `“${candidate.path}” is not a supported preview source.`);

  const workRoot = path.join(project.metaRoot, "tmp", `preview-${newId("op")}`);
  const input = path.join(workRoot, path.basename(candidate.path));
  await mkdir(workRoot, {recursive: true});
  await project.store.materialize(candidate.chunks, input);
  try {
    if (kind === "image") return await attachPreview(project, versionId, input, "generated", options);
    const output = path.join(workRoot, kind === "audio" ? "preview.mp3" : "preview.mp4");
    const duration = options.maxDurationSeconds ?? 600;
    const profile = options.profile ?? "review";
    const audioBitrate = profile === "compact" ? "96k" : profile === "high-quality" ? "256k" : "160k";
    const width = profile === "compact" ? 854 : profile === "high-quality" ? 1920 : 1280;
    const crf = profile === "compact" ? "32" : profile === "high-quality" ? "22" : "28";
    const args = kind === "audio"
      ? ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-t", String(duration), "-vn", "-c:a", "libmp3lame", "-b:a", audioBitrate, output]
      : ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-t", String(duration), "-vf", `scale=min(${width}\\,iw):-2`, "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-c:a", "aac", "-b:a", profile === "compact" ? "96k" : "128k", "-movflags", "+faststart", output];
    await run(options.ffmpegPath ?? "ffmpeg", args, options.signal);
    return await attachPreview(project, versionId, output, "generated", {...options, profile});
  } finally {
    await rm(workRoot, {recursive: true, force: true});
  }
}

export function listPreviews(project: OpenProject, versionId?: string): PreviewRecord[] {
  return project.database.listPreviews(versionId);
}

export function previewPath(project: OpenProject, preview: PreviewRecord): string {
  return safeMetaPath(project, preview.relativePath);
}

export function previewArtifactPath(project: OpenProject, relativePath: string): string {
  return safeMetaPath(project, relativePath);
}

export function classifyMedia(filePath: string): MediaKind {
  const extension = path.extname(filePath).toLowerCase();
  if (AUDIO.has(extension)) return "audio";
  if (VIDEO.has(extension)) return "video";
  if (IMAGE.has(extension)) return "image";
  return "unknown";
}

function safeMetaPath(project: OpenProject, relativePath: string): string {
  const root = path.resolve(project.metaRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!absolute.startsWith(root + path.sep)) throw new AvlabError("AVLAB_UNSAFE_PREVIEW", "The preview points outside its project workspace.");
  return absolute;
}

function previewPriority(filePath: string): number {
  const kind = classifyMedia(filePath);
  return kind === "video" ? 0 : kind === "audio" ? 1 : kind === "image" ? 2 : 99;
}

function mimeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const values: Record<string, string> = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff"
  };
  return values[extension] ?? "application/octet-stream";
}

async function inspectMedia(filePath: string, ffprobePath: string, signal?: AbortSignal): Promise<PreviewMetadata> {
  const output = await runCapture(ffprobePath, ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_name,width,height,r_frame_rate,sample_rate,channels", "-of", "json", filePath], signal);
  const parsed = JSON.parse(output) as {
    format?: {duration?: string; format_name?: string};
    streams?: Array<{codec_name?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number}>;
  };
  const video = parsed.streams?.find(item => item.width || item.height);
  const audio = parsed.streams?.find(item => item.sample_rate || item.channels);
  const durationSeconds = Number(parsed.format?.duration);
  const frameRate = parseRate(video?.r_frame_rate);
  const codec = video?.codec_name ?? audio?.codec_name;
  return {
    ...(Number.isFinite(durationSeconds) ? {durationMs: Math.round(durationSeconds * 1000)} : {}),
    ...(video?.width ? {width: video.width} : {}),
    ...(video?.height ? {height: video.height} : {}),
    ...(frameRate ? {frameRate} : {}),
    ...(audio?.sample_rate && Number.isFinite(Number(audio.sample_rate)) ? {sampleRate: Number(audio.sample_rate)} : {}),
    ...(audio?.channels ? {channels: audio.channels} : {}),
    ...(codec ? {codec} : {}),
    ...(parsed.format?.format_name ? {format: parsed.format.format_name} : {})
  };
}

async function createInspectionArtifacts(
  project: OpenProject,
  previewId: string,
  source: string,
  kind: MediaKind,
  options: PreviewToolOptions
): Promise<Pick<PreviewRecord, "waveformRelativePath" | "thumbnailRelativePath">> {
  if (kind === "unknown") return {};
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  if (kind === "audio") {
    const relative = path.posix.join("previews", `${previewId}-waveform.png`);
    const destination = safeMetaPath(project, relative);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x240:colors=white", "-frames:v", "1", destination], options.signal);
    return {waveformRelativePath: relative};
  }
  const relative = path.posix.join("previews", `${previewId}-thumbnail.jpg`);
  const destination = safeMetaPath(project, relative);
  const args = kind === "video"
    ? ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", source, "-frames:v", "1", "-vf", "scale=min(640\\,iw):-2", destination]
    : ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-frames:v", "1", "-vf", "scale=min(640\\,iw):-2", destination];
  await run(ffmpeg, args, options.signal);
  return {thumbnailRelativePath: relative};
}

function parseRate(value?: string): number | undefined {
  if (!value) return undefined;
  const [left, right] = value.split("/").map(Number);
  const result = right ? left! / right : left;
  return result && Number.isFinite(result) ? result : undefined;
}

async function run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  await runProcess(command, args, signal, false);
}

async function runCapture(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return await runProcess(command, args, signal, true);
}

async function runProcess(command: string, args: string[], signal: AbortSignal | undefined, capture: boolean): Promise<string> {
  if (signal?.aborted) throw new AvlabError("AVLAB_PREVIEW_CANCELLED", "Preview creation was cancelled.");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"]});
    let output = "", errors = "", settled = false;
    const finish = (error?: Error, value = "") => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new AvlabError("AVLAB_PREVIEW_CANCELLED", "Preview creation was cancelled."));
    };
    signal?.addEventListener("abort", abort, {once: true});
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { errors += String(chunk); });
    child.on("error", error => finish(new AvlabError("AVLAB_PREVIEW_TOOL_UNAVAILABLE", `AVlab could not start ${command}: ${error.message}`)));
    child.on("close", code => code === 0 ? finish(undefined, output) : finish(new AvlabError("AVLAB_PREVIEW_FAILED", errors.trim() || `${command} exited with code ${code}`)));
  });
}
