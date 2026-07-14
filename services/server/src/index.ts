import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import {createReadStream, statSync} from "node:fs";
import {appendFile, mkdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import Fastify, {type FastifyInstance, type FastifyReply, type FastifyRequest} from "fastify";
import type {
  ActivityEvent,
  PackageManifest,
  PreviewRecord,
  ProjectDescriptor,
  ProjectMember,
  ReviewComment,
  ReviewDecision,
  ReviewNotification,
  ReviewRecord,
  SyncReceipt,
  TeamRecord,
  VersionRecord
} from "@avlab/contracts";

export interface ServerOptions {
  root: string;
  token: string;
  host?: string;
  port?: number;
  publicBaseUrl?: string;
  reviewUiDirectory?: string;
}
export interface RunningServer {app: FastifyInstance; url: string; close(): Promise<void>;}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  if (!options.token?.trim()) throw new Error("AVlab server requires a non-empty authentication token.");
  const root = path.resolve(options.root);
  await Promise.all(["objects/sha256", "previews", "projects", "uploads"].map(directory => mkdir(path.join(root, directory), {recursive: true})));
  const db = new DatabaseSync(path.join(root, "server.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects(project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(version_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, direction TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, package_data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS heads(project_id TEXT NOT NULL, direction TEXT NOT NULL, version_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,direction));
    CREATE TABLE IF NOT EXISTS previews(preview_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_id TEXT NOT NULL, data TEXT NOT NULL, content_path TEXT);
    CREATE TABLE IF NOT EXISTS reviews(review_id TEXT PRIMARY KEY, token TEXT NOT NULL DEFAULT '', token_hash TEXT, project_id TEXT NOT NULL, version_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comments(comment_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS decisions(decision_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, reviewer_key TEXT, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(member_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_tokens(token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS teams(team_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_objects(project_id TEXT NOT NULL, content_id TEXT NOT NULL, PRIMARY KEY(project_id,content_id));
    CREATE TABLE IF NOT EXISTS activity(event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications(notification_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_receipts(receipt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, completed_at TEXT NOT NULL, data TEXT NOT NULL);
  `);
  ensureColumn(db, "reviews", "token_hash", "TEXT");
  ensureColumn(db, "decisions", "reviewer_key", "TEXT");
  ensureColumn(db, "member_tokens", "active", "INTEGER NOT NULL DEFAULT 1");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS reviews_token_hash_unique ON reviews(token_hash) WHERE token_hash IS NOT NULL;");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS decisions_reviewer_unique ON decisions(review_id,reviewer_key) WHERE reviewer_key IS NOT NULL;");
  migrateReviewTokenHashes(db);

  const app = Fastify({logger: false, bodyLimit: 8 * 1024 * 1024});
  app.addContentTypeParser("application/octet-stream", {parseAs: "buffer"}, (_request, body, done) => done(null, body));
  app.addContentTypeParser(/^audio\//, {parseAs: "buffer"}, (_request, body, done) => done(null, body));
  app.addContentTypeParser(/^video\//, {parseAs: "buffer"}, (_request, body, done) => done(null, body));
  app.addContentTypeParser(/^image\//, {parseAs: "buffer"}, (_request, body, done) => done(null, body));
  app.setErrorHandler((error: unknown, _request, reply) => {
    const item = error as {statusCode?: number; message?: string; code?: string};
    void reply.status(item.statusCode && item.statusCode >= 400 ? item.statusCode : 500).send({
      error: item.code ?? "AVLAB_SERVER_ERROR",
      message: item.message ?? "AVlab server could not complete that action."
    });
  });
  app.get("/health", async () => ({ok: true}));

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url.startsWith("/api/public/")) return;
    const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (secureEqual(supplied, options.token)) return;
    const member = supplied ? db.prepare("SELECT project_id,role FROM member_tokens WHERE token_hash=? AND active=1").get(tokenHash(supplied)) as {project_id: string; role: ProjectMember["role"]} | undefined : undefined;
    if (!member) return reply.status(401).send({error: "AVLAB_NOT_AUTHORIZED", message: "This server token is not valid or has been revoked."});
    const params = request.params as {projectId?: string};
    const bodyProjectId = (request.body as {project?: {projectId?: string}; projectId?: string} | undefined)?.project?.projectId
      ?? (request.body as {projectId?: string} | undefined)?.projectId;
    const requestedProjectId = params.projectId ?? bodyProjectId;
    if (requestedProjectId && requestedProjectId !== member.project_id) {
      return reply.status(403).send({error: "AVLAB_FORBIDDEN", message: "This collaborator does not have access to that project."});
    }
    const objectMatch = request.url.match(/^\/api\/objects\/([^/?]+)/);
    if (request.method === "GET" && objectMatch) {
      const contentId = decodeURIComponent(objectMatch[1]!);
      if (!db.prepare("SELECT 1 FROM project_objects WHERE project_id=? AND content_id=?").get(member.project_id, contentId)) {
        return reply.status(403).send({error: "AVLAB_FORBIDDEN", message: "That project piece is not available to this collaborator."});
      }
    }
    const previewMatch = request.url.match(/^\/api\/previews\/([^/?]+)\/content/);
    if (request.method === "GET" && previewMatch) {
      if (!db.prepare("SELECT 1 FROM previews WHERE project_id=? AND preview_id=?").get(member.project_id, previewMatch[1]!)) {
        return reply.status(403).send({error: "AVLAB_FORBIDDEN", message: "That preview is not available to this collaborator."});
      }
    }
    if (!memberAllows(member.role, request.method, request.url)) {
      return reply.status(403).send({error: "AVLAB_FORBIDDEN", message: "This collaborator role cannot perform that action."});
    }
  });

  app.post("/api/sync/plan", async request => {
    const body = request.body as {project: ProjectDescriptor; objectIds: string[]; versionIds: string[]; previewIds: string[]};
    validateProjectDescriptor(body.project);
    db.prepare(`INSERT INTO projects(project_id,data) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data`)
      .run(body.project.projectId, JSON.stringify(body.project));
    return {
      missingObjectIds: body.objectIds.filter(idValue => !existsObject(root, idValue)),
      missingVersionIds: body.versionIds.filter(idValue => !db.prepare("SELECT 1 FROM versions WHERE version_id=?").get(idValue)),
      missingPreviewIds: body.previewIds.filter(idValue => !db.prepare("SELECT content_path FROM previews WHERE preview_id=? AND content_path IS NOT NULL").get(idValue))
    };
  });

  app.put("/api/objects/:contentId", async (request, reply) => {
    const contentId = decodeURIComponent((request.params as {contentId: string}).contentId);
    const destination = objectPath(root, contentId);
    const result = await receiveResumableUpload(request, reply, destination, contentId);
    return result ?? reply;
  });
  app.get("/api/objects/:contentId", async (request, reply) => sendFile(request, reply, objectPath(root, decodeURIComponent((request.params as {contentId: string}).contentId)), "application/octet-stream"));

  app.put("/api/previews/:previewId/content", async (request, reply) => {
    const previewId = safeName((request.params as {previewId: string}).previewId, "preview");
    const destination = path.join(root, "previews", previewId);
    const result = await receiveResumableUpload(request, reply, destination);
    if (result && result.ok) {
      const current = db.prepare("SELECT data FROM previews WHERE preview_id=?").get(previewId) as {data: string} | undefined;
      if (current) db.prepare("UPDATE previews SET content_path=? WHERE preview_id=?").run(destination, previewId);
      else db.prepare("INSERT INTO previews(preview_id,project_id,version_id,data,content_path) VALUES(?,?,?,?,?)").run(previewId, "pending", "pending", "{}", destination);
    }
    return result ?? reply;
  });
  app.get("/api/previews/:previewId/content", async (request, reply) => {
    const row = db.prepare("SELECT data,content_path FROM previews WHERE preview_id=?").get((request.params as {previewId: string}).previewId) as {data: string; content_path?: string} | undefined;
    if (!row?.content_path) return reply.status(404).send({message: "Preview not found."});
    const preview = JSON.parse(row.data) as PreviewRecord;
    return sendFile(request, reply, row.content_path, preview.mimeType);
  });

  app.post("/api/projects/:projectId/versions", async request => {
    const projectId = (request.params as {projectId: string}).projectId;
    const body = request.body as {version: VersionRecord; packageManifest: PackageManifest; previews: PreviewRecord[]};
    if (body.version.projectId !== projectId || body.packageManifest.projectId !== projectId) badRequest("The version does not belong to this project.");
    for (const objectId of body.packageManifest.entries.flatMap(entry => (entry.chunks ?? []).map(chunk => chunk.contentId))) {
      if (!existsObject(root, objectId)) badRequest(`Required project piece is missing: ${objectId}`);
      db.prepare("INSERT OR IGNORE INTO project_objects(project_id,content_id) VALUES(?,?)").run(projectId, objectId);
    }
    db.prepare(`INSERT INTO versions(version_id,project_id,direction,created_at,data,package_data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(version_id) DO UPDATE SET data=excluded.data,package_data=excluded.package_data`)
      .run(body.version.versionId, projectId, body.version.direction, body.version.createdAt, JSON.stringify(body.version), JSON.stringify(body.packageManifest));
    updateServerHead(db, projectId, body.version);
    for (const preview of body.previews) {
      if (preview.projectId !== projectId || preview.versionId !== body.version.versionId) badRequest("A preview does not belong to the published version.");
      const current = db.prepare("SELECT content_path FROM previews WHERE preview_id=?").get(preview.previewId) as {content_path?: string} | undefined;
      if (current?.content_path) {
        const data = await readFile(current.content_path);
        if (hash(data) !== preview.contentId) badRequest(`Preview failed its integrity check: ${preview.previewId}`);
      }
      db.prepare(`INSERT INTO previews(preview_id,project_id,version_id,data,content_path) VALUES(?,?,?,?,?)
        ON CONFLICT(preview_id) DO UPDATE SET project_id=excluded.project_id,version_id=excluded.version_id,data=excluded.data`)
        .run(preview.previewId, projectId, preview.versionId, JSON.stringify(preview), current?.content_path ?? null);
    }
    addActivity(db, projectId, "version.published", body.version.createdBy.principalId, `Published “${body.version.message}”`, {versionId: body.version.versionId, direction: body.version.direction});
    return {ok: true};
  });

  app.get("/api/projects/:projectId", async (request, reply) => {
    const row = db.prepare("SELECT data FROM projects WHERE project_id=?").get((request.params as {projectId: string}).projectId) as {data: string} | undefined;
    return row ? JSON.parse(row.data) : reply.status(404).send({message: "Project not found."});
  });
  app.get("/api/projects/:projectId/snapshot", async request => {
    const projectId = (request.params as {projectId: string}).projectId;
    const projectRow = db.prepare("SELECT data FROM projects WHERE project_id=?").get(projectId) as {data: string} | undefined;
    if (!projectRow) notFound("Project not found.");
    const rows = db.prepare("SELECT data,package_data FROM versions WHERE project_id=? ORDER BY created_at").all(projectId) as {data: string; package_data: string}[];
    const versions = rows.map(row => {
      const version = JSON.parse(row.data) as VersionRecord;
      return {version, packageManifest: JSON.parse(row.package_data) as PackageManifest, previews: listPreviews(db, version.versionId)};
    });
    const objectIds = [...new Set(versions.flatMap(bundle => bundle.packageManifest.entries.flatMap(entry => (entry.chunks ?? []).map(chunk => chunk.contentId))))];
    const heads = Object.fromEntries((db.prepare("SELECT direction,version_id FROM heads WHERE project_id=?").all(projectId) as {direction: string; version_id: string}[]).map(row => [row.direction, row.version_id]));
    return {project: JSON.parse(projectRow!.data), versions, objectIds, heads};
  });
  app.post("/api/projects/:projectId/sync-receipts", async request => {
    const projectId = (request.params as {projectId: string}).projectId;
    const incoming = request.body as SyncReceipt;
    if (incoming.projectId !== projectId) badRequest("Sync receipt project mismatch.");
    const receipt: SyncReceipt = {...incoming, receiptId: incoming.receiptId || id("syn"), completedAt: incoming.completedAt || new Date().toISOString()};
    db.prepare(`INSERT INTO sync_receipts(receipt_id,project_id,completed_at,data) VALUES(?,?,?,?)
      ON CONFLICT(receipt_id) DO UPDATE SET completed_at=excluded.completed_at,data=excluded.data`)
      .run(receipt.receiptId, projectId, receipt.completedAt, JSON.stringify(receipt));
    return receipt;
  });
  app.get("/api/projects/:projectId/sync-receipts", async request => ({
    receipts: (db.prepare("SELECT data FROM sync_receipts WHERE project_id=? ORDER BY completed_at DESC").all((request.params as {projectId: string}).projectId) as {data: string}[]).map(row => JSON.parse(row.data))
  }));

  app.post("/api/projects/:projectId/reviews", async request => {
    const projectId = (request.params as {projectId: string}).projectId;
    const body = request.body as {versionId: string; title?: string; requiredApprovals?: number; expiresAt?: string; permissions?: ReviewRecord["permissions"]};
    const versionRow = db.prepare("SELECT data FROM versions WHERE version_id=? AND project_id=?").get(body.versionId, projectId) as {data: string} | undefined;
    if (!versionRow) badRequest("Publish the version before requesting review.");
    const version = JSON.parse(versionRow!.data) as VersionRecord;
    const reviewId = id("rev"), token = randomBytes(32).toString("base64url");
    const permissions = normalizeReviewPermissions(body.permissions);
    const review: ReviewRecord = {
      schema: "avlab.review/0.1", reviewId, projectId, versionId: version.versionId,
      ...(version.parentVersionIds[0] ? {baseVersionId: version.parentVersionIds[0]} : {}),
      title: body.title?.trim() || version.message,
      token,
      permissions,
      requiredApprovals: Math.max(1, Math.floor(body.requiredApprovals ?? 1)),
      status: "open", createdAt: new Date().toISOString(), ...(body.expiresAt ? {expiresAt: body.expiresAt} : {})
    };
    const stored = {...review, token: ""};
    db.prepare("INSERT INTO reviews(review_id,token,token_hash,project_id,version_id,status,data) VALUES(?,?,?,?,?,?,?)")
      .run(reviewId, "", tokenHash(token), projectId, version.versionId, review.status, JSON.stringify(stored));
    addActivity(db, projectId, "review.created", "local-human", `Requested review for “${version.message}”`, {reviewId, versionId: version.versionId, permissions});
    addNotification(db, projectId, reviewId, "review-status", `Review opened: ${review.title}`);
    const base = options.publicBaseUrl?.replace(/\/+$/, "") ?? `http://${options.host ?? "127.0.0.1"}:${actualPort(app)}`;
    return {review, reviewUrl: `${base}/review/${token}`};
  });
  app.get("/api/projects/:projectId/reviews", async request => ({reviews: (db.prepare("SELECT data FROM reviews WHERE project_id=? ORDER BY rowid DESC").all((request.params as {projectId: string}).projectId) as {data: string}[]).map(row => hideToken(JSON.parse(row.data) as ReviewRecord))}));
  app.get("/api/projects/:projectId/activity", async request => ({events: (db.prepare("SELECT data FROM activity WHERE project_id=? ORDER BY created_at DESC").all((request.params as {projectId: string}).projectId) as {data: string}[]).map(row => JSON.parse(row.data))}));
  app.get("/api/projects/:projectId/notifications", async request => ({notifications: (db.prepare("SELECT data FROM notifications WHERE project_id=? ORDER BY created_at DESC").all((request.params as {projectId: string}).projectId) as {data: string}[]).map(row => JSON.parse(row.data))}));

  app.get("/api/projects/:projectId/members", async request => ({members: (db.prepare("SELECT data FROM members WHERE project_id=? ORDER BY rowid").all((request.params as {projectId: string}).projectId) as {data: string}[]).map(row => JSON.parse(row.data))}));
  app.post("/api/projects/:projectId/members", async request => {
    const projectId = (request.params as {projectId: string}).projectId;
    const body = request.body as {displayName: string; email?: string; role: ProjectMember["role"]};
    if (!body.displayName?.trim()) badRequest("Give the collaborator a display name.");
    if (!validRole(body.role)) badRequest("That collaborator role is not supported.");
    const member: ProjectMember = {schema: "avlab.member/0.1", memberId: id("mem"), projectId, displayName: body.displayName.trim(), ...(body.email ? {email: body.email.trim()} : {}), role: body.role, status: "active", createdAt: new Date().toISOString()};
    db.prepare("INSERT INTO members(member_id,project_id,data) VALUES(?,?,?)").run(member.memberId, projectId, JSON.stringify(member));
    const accessToken = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO member_tokens(token_hash,member_id,project_id,role,active) VALUES(?,?,?,?,1)").run(tokenHash(accessToken), member.memberId, projectId, member.role);
    addActivity(db, projectId, "member.added", "server-admin", `Added ${member.displayName}`, {memberId: member.memberId, role: member.role});
    return {member, accessToken};
  });
  app.post("/api/projects/:projectId/members/:memberId/revoke", async request => {
    const params = request.params as {projectId: string; memberId: string};
    const row = db.prepare("SELECT data FROM members WHERE project_id=? AND member_id=?").get(params.projectId, params.memberId) as {data: string} | undefined;
    if (!row) notFound("Collaborator not found.");
    const current = JSON.parse(row!.data) as ProjectMember;
    const member: ProjectMember = {...current, status: "revoked", revokedAt: new Date().toISOString()};
    db.prepare("UPDATE members SET data=? WHERE member_id=?").run(JSON.stringify(member), params.memberId);
    db.prepare("UPDATE member_tokens SET active=0 WHERE member_id=?").run(params.memberId);
    addActivity(db, params.projectId, "member.revoked", "server-admin", `Revoked ${member.displayName}`, {memberId: member.memberId});
    return {member};
  });

  app.get("/api/projects/:projectId/teams", async request => ({teams: (db.prepare("SELECT data FROM teams WHERE project_id=? ORDER BY rowid").all((request.params as {projectId: string}).projectId) as {data: string}[]).map(row => JSON.parse(row.data))}));
  app.post("/api/projects/:projectId/teams", async request => {
    const projectId = (request.params as {projectId: string}).projectId;
    const body = request.body as {name: string; memberIds?: string[]};
    if (!body.name?.trim()) badRequest("Give the team a name.");
    const memberIds = [...new Set(body.memberIds ?? [])];
    for (const memberId of memberIds) if (!db.prepare("SELECT 1 FROM members WHERE project_id=? AND member_id=?").get(projectId, memberId)) badRequest(`Collaborator not found: ${memberId}`);
    const team: TeamRecord = {schema: "avlab.team/0.1", teamId: id("team"), projectId, name: body.name.trim(), memberIds, createdAt: new Date().toISOString()};
    db.prepare("INSERT INTO teams(team_id,project_id,data) VALUES(?,?,?)").run(team.teamId, projectId, JSON.stringify(team));
    addActivity(db, projectId, "team.created", "server-admin", `Created team ${team.name}`, {teamId: team.teamId});
    return {team};
  });

  app.get("/api/public/reviews/:token", async (request, reply) => {
    const review = publicReview(db, (request.params as {token: string}).token);
    if (!review) return reply.status(404).send({message: "Review link not found or expired."});
    const version = versionById(db, review.versionId), baseVersion = review.baseVersionId ? versionById(db, review.baseVersionId) : undefined;
    return {review: hideToken(review), version, baseVersion, previews: listPreviews(db, review.versionId), basePreviews: review.baseVersionId ? listPreviews(db, review.baseVersionId) : [], comments: comments(db, review.reviewId), decisions: decisions(db, review.reviewId)};
  });
  app.get("/api/public/reviews/:token/previews/:previewId", async (request, reply) => {
    const params = request.params as {token: string; previewId: string};
    const review = publicReview(db, params.token);
    if (!review) return reply.status(404).send({message: "Review link not found or expired."});
    const row = reviewPreview(db, review, params.previewId);
    if (!row?.content_path) return reply.status(404).send({message: "Preview not found."});
    const preview = JSON.parse(row.data) as PreviewRecord;
    return sendFile(request, reply, row.content_path, preview.mimeType);
  });
  app.get("/api/public/reviews/:token/downloads/:previewId", async (request, reply) => {
    const params = request.params as {token: string; previewId: string};
    const review = publicReview(db, params.token);
    if (!review) return reply.status(404).send({message: "Review link not found or expired."});
    if (!review.permissions.includes("download")) return reply.status(403).send({message: "Downloads are not allowed for this review."});
    const row = reviewPreview(db, review, params.previewId);
    if (!row?.content_path) return reply.status(404).send({message: "Preview not found."});
    const preview = JSON.parse(row.data) as PreviewRecord;
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(preview.fileName)}`);
    return sendFile(request, reply, row.content_path, preview.mimeType);
  });
  app.post("/api/public/reviews/:token/comments", async request => {
    const review = publicReview(db, (request.params as {token: string}).token);
    if (!review || !review.permissions.includes("comment")) forbidden("Comments are not allowed for this review.");
    const body = request.body as {author?: string; body: string; anchor?: ReviewComment["anchor"]; parentCommentId?: string};
    if (!body.body?.trim()) badRequest("Write a comment before posting.");
    if (body.parentCommentId && !db.prepare("SELECT 1 FROM comments WHERE comment_id=? AND review_id=?").get(body.parentCommentId, review!.reviewId)) badRequest("The comment thread was not found.");
    validateAnchor(body.anchor);
    const comment: ReviewComment = {
      schema: "avlab.review-comment/0.1", commentId: id("cmt"), reviewId: review!.reviewId,
      author: body.author?.trim() || "Guest reviewer", body: body.body.trim(), anchor: body.anchor ?? {type: "general"},
      ...(body.parentCommentId ? {parentCommentId: body.parentCommentId} : {}), createdAt: new Date().toISOString()
    };
    db.prepare("INSERT INTO comments(comment_id,review_id,data) VALUES(?,?,?)").run(comment.commentId, review!.reviewId, JSON.stringify(comment));
    addActivity(db, review!.projectId, "review.comment", comment.author, body.parentCommentId ? "Replied to review feedback" : "Added review feedback", {reviewId: review!.reviewId, commentId: comment.commentId, parentCommentId: body.parentCommentId});
    addNotification(db, review!.projectId, review!.reviewId, "review-comment", `${comment.author}: ${comment.body.slice(0, 120)}`);
    return {comment};
  });
  app.post("/api/public/reviews/:token/comments/:commentId/resolve", async request => {
    const params = request.params as {token: string; commentId: string};
    const review = publicReview(db, params.token);
    if (!review || !review.permissions.includes("comment")) forbidden("Comments are not allowed for this review.");
    const row = db.prepare("SELECT data FROM comments WHERE comment_id=? AND review_id=?").get(params.commentId, review!.reviewId) as {data: string} | undefined;
    if (!row) notFound("Comment not found.");
    const body = request.body as {author?: string};
    const comment: ReviewComment = {...JSON.parse(row!.data) as ReviewComment, resolvedAt: new Date().toISOString(), resolvedBy: body.author?.trim() || "Guest reviewer"};
    db.prepare("UPDATE comments SET data=? WHERE comment_id=?").run(JSON.stringify(comment), comment.commentId);
    addActivity(db, review!.projectId, "review.comment-resolved", comment.resolvedBy!, "Resolved review feedback", {reviewId: review!.reviewId, commentId: comment.commentId});
    return {comment};
  });
  app.post("/api/public/reviews/:token/decision", async request => {
    const review = publicReview(db, (request.params as {token: string}).token);
    if (!review || !review.permissions.includes("approve")) forbidden("Decisions are not allowed for this review.");
    const body = request.body as {author?: string; decision: ReviewDecision["decision"]; message?: string};
    if (!["approve", "request-changes", "reject"].includes(body.decision)) badRequest("That review decision is not supported.");
    const author = body.author?.trim() || "Guest reviewer";
    const reviewerKey = author.toLocaleLowerCase();
    db.prepare("DELETE FROM decisions WHERE review_id=? AND reviewer_key=?").run(review!.reviewId, reviewerKey);
    const decision: ReviewDecision = {schema: "avlab.review-decision/0.1", decisionId: id("dec"), reviewId: review!.reviewId, author, decision: body.decision, ...(body.message?.trim() ? {message: body.message.trim()} : {}), createdAt: new Date().toISOString()};
    db.prepare("INSERT INTO decisions(decision_id,review_id,reviewer_key,data) VALUES(?,?,?,?)").run(decision.decisionId, review!.reviewId, reviewerKey, JSON.stringify(decision));
    const status = calculateReviewStatus(decisions(db, review!.reviewId), review!.requiredApprovals);
    const updated: ReviewRecord = {...review!, status};
    db.prepare("UPDATE reviews SET status=?,data=? WHERE review_id=?").run(status, JSON.stringify({...updated, token: ""}), review!.reviewId);
    addActivity(db, review!.projectId, `review.${body.decision}`, decision.author, `Review decision: ${body.decision}`, {reviewId: review!.reviewId});
    addNotification(db, review!.projectId, review!.reviewId, "review-decision", `${decision.author}: ${body.decision}`);
    if (status !== review!.status) addNotification(db, review!.projectId, review!.reviewId, "review-status", `Review status changed to ${status}`);
    return {decision, review: hideToken(updated)};
  });

  app.get("/review/:token", async (request, reply) => {
    const token = (request.params as {token: string}).token;
    if (!publicReview(db, token)) return reply.status(404).type("text/html").send("<h1>Review not found</h1>");
    if (options.reviewUiDirectory) return serveReviewUi(options.reviewUiDirectory, request, reply);
    return reply.type("text/html").send(reviewFallbackHtml(token));
  });
  app.get("/review-assets/*", async (request, reply) => options.reviewUiDirectory ? serveReviewUi(options.reviewUiDirectory, request, reply) : reply.status(404).send("Not found"));

  await app.listen({host: options.host ?? "127.0.0.1", port: options.port ?? 0});
  const url = `http://${options.host ?? "127.0.0.1"}:${actualPort(app)}`;
  return {app, url, async close() {await app.close(); db.close();}};
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[];
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function migrateReviewTokenHashes(db: DatabaseSync): void {
  const rows = db.prepare("SELECT review_id,token,token_hash FROM reviews").all() as {review_id: string; token: string; token_hash?: string}[];
  for (const row of rows) if (!row.token_hash && row.token) db.prepare("UPDATE reviews SET token_hash=? WHERE review_id=?").run(tokenHash(row.token), row.review_id);
}

function validateProjectDescriptor(project: ProjectDescriptor): void {
  if (!project?.projectId || project.schema !== "avlab.project/0.1") badRequest("The remote project description is invalid.");
}
function validRole(role: string): role is ProjectMember["role"] {return ["view", "comment", "prepare", "apply", "approve", "deliver", "full"].includes(role);}
function normalizeReviewPermissions(input?: ReviewRecord["permissions"]): ReviewRecord["permissions"] {
  const allowed = new Set<ReviewRecord["permissions"][number]>(["view", "comment", "approve", "download"]);
  const requested: ReviewRecord["permissions"] = input?.length ? input : ["view", "comment", "approve"];
  const values: ReviewRecord["permissions"] = [...new Set(requested.filter(item => allowed.has(item)))];
  if (!values.includes("view")) values.unshift("view");
  return values;
}
function validateAnchor(anchor?: ReviewComment["anchor"]): void {
  if (!anchor) return;
  if (anchor.type === "preview-time" && (!Number.isFinite(anchor.timeMs) || anchor.timeMs! < 0)) badRequest("The playback time is invalid.");
  if (anchor.type === "frame" && (!Number.isInteger(anchor.frame) || anchor.frame! < 0)) badRequest("The frame number is invalid.");
  if (anchor.type === "object" && !anchor.objectId?.trim()) badRequest("The review object anchor is invalid.");
}
function calculateReviewStatus(all: ReviewDecision[], requiredApprovals: number): ReviewRecord["status"] {
  if (all.some(item => item.decision === "reject")) return "rejected";
  if (all.some(item => item.decision === "request-changes")) return "changes-requested";
  return all.filter(item => item.decision === "approve").length >= requiredApprovals ? "approved" : "open";
}
function updateServerHead(db: DatabaseSync, projectId: string, version: VersionRecord): void {
  const current = db.prepare("SELECT created_at FROM heads WHERE project_id=? AND direction=?").get(projectId, version.direction) as {created_at: string} | undefined;
  if (current && current.created_at > version.createdAt) return;
  db.prepare(`INSERT INTO heads(project_id,direction,version_id,created_at) VALUES(?,?,?,?)
    ON CONFLICT(project_id,direction) DO UPDATE SET version_id=excluded.version_id,created_at=excluded.created_at`)
    .run(projectId, version.direction, version.versionId, version.createdAt);
}

async function receiveResumableUpload(request: FastifyRequest, reply: FastifyReply, destination: string, expectedContentId?: string): Promise<{ok: true; bytes: number} | undefined> {
  const data = Buffer.isBuffer(request.body) ? request.body : Buffer.from((request.body as ArrayBuffer | undefined) ?? new ArrayBuffer(0));
  const range = parseContentRange(request.headers["content-range"]);
  await mkdir(path.dirname(destination), {recursive: true});
  if (!range) {
    if (expectedContentId && hash(data) !== expectedContentId) badRequest("Uploaded project piece failed its integrity check.");
    await atomicFileWrite(destination, data);
    return {ok: true, bytes: data.length};
  }
  const partial = `${destination}.part`;
  const existing = (await stat(partial).catch(() => ({size: 0}))).size;
  if (range.total === 0) {
    await atomicFileWrite(destination, Buffer.alloc(0));
    return {ok: true, bytes: 0};
  }
  if (range.start !== existing) {
    reply.status(409).header("x-avlab-next-offset", String(existing)).send({error: "AVLAB_UPLOAD_OFFSET", message: "Resume the upload from the expected byte offset.", expectedStart: existing});
    return undefined;
  }
  if (data.length !== range.end - range.start + 1) badRequest("The uploaded byte range length is invalid.");
  await appendFile(partial, data, {mode: 0o600});
  if (range.end + 1 < range.total) {
    reply.status(308).header("range", `bytes=0-${range.end}`).header("x-avlab-next-offset", String(range.end + 1)).send({received: range.end + 1});
    return undefined;
  }
  const info = await stat(partial);
  if (info.size !== range.total) badRequest("The resumable upload did not contain the expected number of bytes.");
  const complete = await readFile(partial);
  if (expectedContentId && hash(complete) !== expectedContentId) {
    await rm(partial, {force: true});
    badRequest("Uploaded project piece failed its integrity check.");
  }
  await rm(destination, {force: true});
  await rename(partial, destination);
  return {ok: true, bytes: complete.length};
}
function parseContentRange(value: string | string[] | undefined): {start: number; end: number; total: number} | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return undefined;
  const match = text.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) badRequest("The upload byte range is invalid.");
  const start = Number(match![1]), end = Number(match![2]), total = Number(match![3]);
  if (start < 0 || end < start || total < 0 || (total > 0 && end >= total)) badRequest("The upload byte range is invalid.");
  return {start, end, total};
}
async function atomicFileWrite(destination: string, data: Buffer): Promise<void> {
  const temporary = `${destination}.${process.pid}.${Date.now()}.part`;
  await writeFile(temporary, data, {mode: 0o600});
  await rm(destination, {force: true});
  await rename(temporary, destination);
}

function objectPath(root: string, contentId: string): string {
  const [algorithm, digest] = contentId.split(":");
  if (algorithm !== "sha256" || !digest || !/^[a-f0-9]{64}$/.test(digest)) badRequest("Invalid content identifier.");
  return path.join(root, "objects", "sha256", digest!.slice(0, 2), digest!);
}
function existsObject(root: string, contentId: string): boolean {try {return statSync(objectPath(root, contentId)).isFile();} catch {return false;}}
function hash(data: Buffer): string {return `sha256:${createHash("sha256").update(data).digest("hex")}`;}
function id(prefix: string): string {return `${prefix}_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;}
function actualPort(app: FastifyInstance): number {const address = app.server.address(); return typeof address === "object" && address ? address.port : 0;}
function secureEqual(left: string, right: string): boolean {const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);}
function safeName(value: string, kind: string): string {if (!/^[A-Za-z0-9_-]+$/.test(value)) badRequest(`Invalid ${kind} identifier.`); return value;}

async function sendFile(request: FastifyRequest, reply: FastifyReply, file: string, mime: string): Promise<FastifyReply> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return reply.status(404).send({message: "File not found."});
  reply.type(mime).header("accept-ranges", "bytes");
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const requestedEnd = range[2] ? Number(range[2]) : info.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= info.size || requestedEnd < start) {
      return reply.status(416).header("content-range", `bytes */${info.size}`).send();
    }
    const end = Math.min(requestedEnd, info.size - 1);
    reply.status(206).header("content-range", `bytes ${start}-${end}/${info.size}`).header("content-length", String(end - start + 1));
    return reply.send(createReadStream(file, {start, end}));
  }
  reply.header("content-length", String(info.size));
  return reply.send(createReadStream(file));
}

function listPreviews(db: DatabaseSync, versionId: string): PreviewRecord[] {return (db.prepare("SELECT data FROM previews WHERE version_id=? ORDER BY rowid DESC").all(versionId) as {data: string}[]).map(row => JSON.parse(row.data) as PreviewRecord);}
function versionById(db: DatabaseSync, idValue: string): VersionRecord | undefined {const row = db.prepare("SELECT data FROM versions WHERE version_id=?").get(idValue) as {data: string} | undefined; return row ? JSON.parse(row.data) as VersionRecord : undefined;}
function publicReview(db: DatabaseSync, token: string): ReviewRecord | undefined {
  const digest = tokenHash(token);
  const row = db.prepare("SELECT data FROM reviews WHERE token_hash=? OR token=?").get(digest, token) as {data: string} | undefined;
  if (!row) return;
  const review = JSON.parse(row.data) as ReviewRecord;
  if (review.expiresAt && new Date(review.expiresAt).getTime() < Date.now()) return;
  return {...review, token};
}
function hideToken(review: ReviewRecord): ReviewRecord {return {...review, token: ""};}
function comments(db: DatabaseSync, reviewId: string): ReviewComment[] {return (db.prepare("SELECT data FROM comments WHERE review_id=? ORDER BY rowid").all(reviewId) as {data: string}[]).map(row => JSON.parse(row.data) as ReviewComment);}
function decisions(db: DatabaseSync, reviewId: string): ReviewDecision[] {return (db.prepare("SELECT data FROM decisions WHERE review_id=? ORDER BY rowid").all(reviewId) as {data: string}[]).map(row => JSON.parse(row.data) as ReviewDecision);}
function reviewPreview(db: DatabaseSync, review: ReviewRecord, previewId: string): {data: string; content_path?: string} | undefined {
  const row = db.prepare("SELECT data,content_path FROM previews WHERE preview_id=?").get(previewId) as {data: string; content_path?: string} | undefined;
  if (!row) return undefined;
  const preview = JSON.parse(row.data) as PreviewRecord;
  return [review.versionId, review.baseVersionId].includes(preview.versionId) ? row : undefined;
}
function addActivity(db: DatabaseSync, projectId: string, type: string, actor: string, summary: string, details: Record<string, unknown>): void {
  const event: ActivityEvent = {schema: "avlab.activity/0.1", eventId: id("evt"), projectId, type, actor, summary, createdAt: new Date().toISOString(), details};
  db.prepare("INSERT INTO activity(event_id,project_id,created_at,data) VALUES(?,?,?,?)").run(event.eventId, projectId, event.createdAt, JSON.stringify(event));
}
function addNotification(db: DatabaseSync, projectId: string, reviewId: string, type: ReviewNotification["type"], summary: string): void {
  const notification: ReviewNotification = {notificationId: id("ntf"), projectId, reviewId, type, summary, createdAt: new Date().toISOString()};
  db.prepare("INSERT INTO notifications(notification_id,project_id,created_at,data) VALUES(?,?,?,?)").run(notification.notificationId, projectId, notification.createdAt, JSON.stringify(notification));
}
async function serveReviewUi(directory: string, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const raw = request.url.split("?")[0] ?? "/";
  const requested = raw.startsWith("/review-assets/") ? raw.slice("/review-assets/".length) : "index.html";
  let file = path.resolve(directory, requested);
  const root = path.resolve(directory);
  if (!file.startsWith(root + path.sep) && file !== path.resolve(root, "index.html")) return reply.status(404).send("Not found");
  if (!(await stat(file).catch(() => undefined))?.isFile()) file = path.join(root, "index.html");
  const ext = path.extname(file);
  const mime: Record<string, string> = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"};
  reply.type(mime[ext] ?? "application/octet-stream");
  return reply.send(await readFile(file));
}
function tokenHash(token: string): string {return createHash("sha256").update(token).digest("hex");}
function memberAllows(role: ProjectMember["role"], method: string, url: string): boolean {
  const level: Record<ProjectMember["role"], number> = {view: 0, comment: 1, prepare: 2, apply: 3, approve: 4, deliver: 5, full: 6};
  if (method === "GET") return true;
  if (url.includes("/members") || url.includes("/teams")) return role === "full";
  if (url.includes("/reviews")) return level[role] >= 2;
  if (url.includes("/versions") || url.includes("/sync/plan") || url.includes("/sync-receipts") || url.includes("/objects/") || url.includes("/previews/")) return level[role] >= 2;
  return false;
}
function reviewFallbackHtml(token: string): string {return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AVlab Review</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 20px;background:#f5f5f1;color:#171717}video,audio{width:100%}.card{background:white;border:1px solid #ddd;border-radius:16px;padding:24px;margin:16px 0}button,input,textarea,select{font:inherit;padding:10px;margin:4px}textarea{width:100%;min-height:90px}</style><h1>AVlab review</h1><div id="app">Opening review…</div><script>const token=${JSON.stringify(token)};async function load(){const r=await fetch('/api/public/reviews/'+token);const d=await r.json();if(!r.ok){app.textContent=d.message;return}const p=d.previews[0];app.innerHTML='<div class="card"><h2>'+escapeHtml(d.review.title)+'</h2><p>'+escapeHtml(d.version.message)+'</p>'+(p?'<'+(p.mediaKind==='video'?'video':'audio')+' controls src="/api/public/reviews/'+token+'/previews/'+p.previewId+'"></'+(p.mediaKind==='video'?'video':'audio')+'>':'<p>No preview attached.</p>')+'</div><div class="card"><h3>Leave feedback</h3><input id="author" placeholder="Your name"><textarea id="body" placeholder="What should change?"></textarea><button onclick="comment()">Post comment</button><button onclick="decision(\'approve\')">Approve</button><button onclick="decision(\'request-changes\')">Request changes</button><div id="comments"></div></div>';comments.innerHTML=d.comments.map(c=>'<p><b>'+escapeHtml(c.author)+':</b> '+escapeHtml(c.body)+'</p>').join('')}function escapeHtml(v){return String(v).replace(/[&<>\"]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[x]))}async function comment(){await fetch('/api/public/reviews/'+token+'/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({author:author.value,body:body.value})});load()}async function decision(value){await fetch('/api/public/reviews/'+token+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({author:author.value,decision:value})});load()}load()</script>`;}
function badRequest(message: string): never {throw Object.assign(new Error(message), {statusCode: 400, code: "AVLAB_BAD_REQUEST"});}
function forbidden(message: string): never {throw Object.assign(new Error(message), {statusCode: 403, code: "AVLAB_FORBIDDEN"});}
function notFound(message: string): never {throw Object.assign(new Error(message), {statusCode: 404, code: "AVLAB_NOT_FOUND"});}
