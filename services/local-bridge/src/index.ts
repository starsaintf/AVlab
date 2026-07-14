import {randomBytes, timingSafeEqual} from "node:crypto";
import {readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import chokidar, {type FSWatcher} from "chokidar";
import Fastify, {type FastifyInstance, type FastifyReply, type FastifyRequest} from "fastify";
import {
  compareVersions,
  createVersion,
  openProject,
  restoreVersion,
  storageStatus,
  verifyProject,
  type OpenProject
} from "@avlab/core";

export interface BridgeOptions {
  projectPath: string;
  port?: number;
  host?: string;
  uiDirectory?: string;
  automaticRecovery?: boolean;
  recoveryDelayMs?: number;
}

export interface RunningBridge {
  app: FastifyInstance;
  project: OpenProject;
  launchUrl: string;
  close(): Promise<void>;
}

export async function startBridge(options: BridgeOptions): Promise<RunningBridge> {
  const project = await openProject(options.projectPath);
  const token = await getOrCreateToken(project);
  const app = Fastify({logger: false, bodyLimit: 1024 * 1024});
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const state = {dirty: false, lastChangeAt: undefined as string | undefined, operation: Promise.resolve() as Promise<unknown>};

  app.setErrorHandler((error: unknown, _request, reply) => {
    const candidate = error as {statusCode?: number; message?: string};
    const status = candidate.statusCode && candidate.statusCode >= 400 ? candidate.statusCode : 500;
    void reply.status(status).send({error: "AVLAB_BRIDGE_ERROR", message: candidate.message ?? "AVlab could not complete that action."});
  });

  app.get("/health", async () => ({ok: true, projectId: project.descriptor.projectId}));
  app.get("/session", async (request, reply) => {
    const supplied = (request.query as {token?: string}).token ?? "";
    if (!secureEqual(supplied, token)) return reply.status(401).send({error: "AVLAB_BAD_SESSION", message: "This AVlab link is no longer valid."});
    reply.header("Set-Cookie", `avlab_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return reply.redirect("/");
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const supplied = bearerToken(request) ?? cookieToken(request);
    if (!supplied || !secureEqual(supplied, token)) return reply.status(401).send({error: "AVLAB_NOT_AUTHORIZED", message: "Reconnect this window to the AVlab desktop bridge."});
  });

  app.get("/api/project", async () => ({project: project.descriptor, settings: project.settings, dirty: state.dirty, lastChangeAt: state.lastChangeAt}));
  app.get("/api/versions", async request => ({versions: project.database.listVersions((request.query as {all?: string}).all === "true")}));
  app.get("/api/storage", async () => storageStatus(project));
  app.get("/api/verify", async () => verifyProject(project));
  app.get("/api/compare", async request => {
    const query = request.query as {from?: string; to?: string};
    if (!query.from || !query.to) throw new Error("Choose two saved versions to compare.");
    return compareVersions(project, query.from, query.to);
  });
  app.post("/api/versions", async request => enqueue(state, async () => {
    const body = (request.body ?? {}) as {message?: string; direction?: string; kind?: "named" | "recovery"};
    const createInput = {kind: body.kind ?? "named", ...(body.message !== undefined ? {message: body.message} : {}), ...(body.direction !== undefined ? {direction: body.direction} : {})};
    const version = await createVersion(project, createInput);
    state.dirty = false;
    return {message: body.kind === "recovery" ? "Recovery point created." : "Version saved.", version};
  }));
  app.post("/api/restore", async request => enqueue(state, async () => {
    const versionId = (request.body as {versionId?: string} | undefined)?.versionId;
    if (!versionId) throw new Error("Choose a saved version to restore.");
    await restoreVersion(project, versionId);
    state.dirty = false;
    return {message: "Project restored.", versionId};
  }));

  const uiDirectory = options.uiDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/desktop/dist");
  app.get("/", async (request, reply) => serveUi(uiDirectory, request, reply));
  app.get("/*", async (request, reply) => serveUi(uiDirectory, request, reply));

  await app.listen({host, port});
  const watcher = await startWatcher(project, () => {
    state.dirty = true;
    state.lastChangeAt = new Date().toISOString();
  }, options.automaticRecovery !== false ? async () => {
    if (!state.dirty) return;
    await enqueue(state, async () => {
      await createVersion(project, {kind: "recovery", message: "Automatic recovery point"});
      state.dirty = false;
    });
  } : undefined, options.recoveryDelayMs);

  return {
    app,
    project,
    launchUrl: `http://${host}:${actualPort(app)}/session?token=${encodeURIComponent(token)}`,
    async close() {
      await watcher.close();
      await app.close();
      project.database.close();
    }
  };
}

function actualPort(app: FastifyInstance): number {
  const address = app.server.address();
  return typeof address === "object" && address ? address.port : 4317;
}

async function getOrCreateToken(project: OpenProject): Promise<string> {
  const tokenPath = path.join(project.metaRoot, "bridge-token");
  const existing = await readFile(tokenPath, "utf8").catch(() => "");
  if (existing.trim()) return existing.trim();
  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, {encoding: "utf8", mode: 0o600});
  return token;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

function cookieToken(request: FastifyRequest): string | undefined {
  const cookies = request.headers.cookie?.split(";").map(part => part.trim()) ?? [];
  const item = cookies.find(part => part.startsWith("avlab_session="));
  return item?.slice("avlab_session=".length);
}

async function enqueue<T>(state: {operation: Promise<unknown>}, operation: () => Promise<T>): Promise<T> {
  const next = state.operation.then(operation, operation);
  state.operation = next.then(() => undefined, () => undefined);
  return next;
}

async function startWatcher(project: OpenProject, onDirty: () => void, onRecovery?: () => Promise<void>, recoveryDelayMs?: number): Promise<FSWatcher> {
  const targets = project.descriptor.includePaths.map(include => include === "." ? project.root : path.resolve(project.root, include));
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    persistent: true,
    ignored: watched => watched === project.metaRoot || watched.startsWith(`${project.metaRoot}${path.sep}`),
    awaitWriteFinish: {stabilityThreshold: 750, pollInterval: 100}
  });
  let timer: NodeJS.Timeout | undefined;
  const changed = (): void => {
    onDirty();
    if (!onRecovery) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void onRecovery().catch(() => undefined), recoveryDelayMs ?? Math.max(1, project.settings.recoveryMinutes) * 60_000);
  };
  watcher.on("add", changed).on("change", changed).on("unlink", changed).on("addDir", changed).on("unlinkDir", changed);
  return watcher;
}

async function serveUi(uiDirectory: string, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const urlPath = request.url.split("?")[0] ?? "/";
  const requested = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  let filePath = path.resolve(uiDirectory, requested);
  if (!filePath.startsWith(path.resolve(uiDirectory) + path.sep) && filePath !== path.resolve(uiDirectory, "index.html")) return reply.status(404).send("Not found");
  if (!(await stat(filePath).catch(() => undefined))?.isFile()) filePath = path.join(uiDirectory, "index.html");
  const extension = path.extname(filePath);
  const mime: Record<string, string> = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"};
  reply.type(mime[extension] ?? "application/octet-stream");
  return reply.send(await readFile(filePath));
}
