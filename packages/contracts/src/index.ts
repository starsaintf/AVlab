export const SCHEMA_VERSION = "0.2" as const;

export type CapabilityLevel = "U0" | "U1" | "U2" | "U3" | "U4" | "U5";
export type EntryKind = "file" | "directory" | "symlink";
export type VersionKind = "named" | "recovery" | "agent-proposal";
export type MediaKind = "audio" | "video" | "image" | "unknown";
export type PreviewSource = "generated" | "user-export" | "host-render" | "agent-render";
export type PreviewProfile = "compact" | "review" | "high-quality";
export type ProposalStatus = "draft" | "under-review" | "changes-requested" | "approved" | "rejected" | "applied";
export type ReviewDecisionValue = "approve" | "request-changes" | "reject";
export type ProjectRole = "view" | "comment" | "prepare" | "apply" | "approve" | "deliver" | "full";

export interface ProjectDescriptor {
  schema: "avlab.project/0.1";
  projectId: string;
  name: string;
  createdAt: string;
  rootKind: "directory" | "single-file";
  includePaths: string[];
  defaultDirection: string;
  capabilityLevel: CapabilityLevel;
  extensions: Record<string, unknown>;
}

export interface ChunkRef {contentId: string; size: number; offset: number;}
export interface PackageEntry {path: string; kind: EntryKind; mode: number; mtimeMs: number; size?: number; contentId?: string; chunks?: ChunkRef[]; linkTarget?: string;}
export interface PackageManifest {schema: "avlab.package/0.1"; packageId: string; projectId: string; createdAt: string; entries: PackageEntry[]; totalBytes: number; uniqueBytesWritten: number;}
export interface VersionRecord {schema: "avlab.version/0.1"; versionId: string; projectId: string; parentVersionIds: string[]; direction: string; kind: VersionKind; message: string; createdAt: string; createdBy: {principalId: string; onBehalfOf?: string}; packageId: string; manifestPath: string;}
export interface FileChange {path: string; change: "added" | "removed" | "modified" | "metadata"; beforeContentId?: string; afterContentId?: string;}
export interface CompareResult {fromVersionId: string; toVersionId: string; changes: FileChange[];}
export interface StorageStatus {objectCount: number; storedBytes: number; reachableObjectCount: number; reachableBytes: number; missingObjects: string[];}

export interface PreviewMetadata {durationMs?: number; width?: number; height?: number; frameRate?: number; sampleRate?: number; channels?: number; codec?: string; format?: string;}
export interface PreviewRecord {schema: "avlab.preview/0.1"; previewId: string; projectId: string; versionId: string; mediaKind: MediaKind; mimeType: string; fileName: string; relativePath: string; source: PreviewSource; profile?: PreviewProfile; size: number; contentId: string; createdAt: string; durationMs?: number; metadata?: PreviewMetadata; waveformRelativePath?: string; thumbnailRelativePath?: string;}
export interface DirectionRecord {schema: "avlab.direction/0.1"; projectId: string; name: string; baseVersionId?: string; headVersionId?: string; createdAt: string; createdBy: string; archived: boolean;}
export interface ProposalRecord {schema: "avlab.proposal/0.1"; proposalId: string; projectId: string; versionId: string; title: string; status: ProposalStatus; createdAt: string; createdBy: string; reviewId?: string; reviewUrl?: string;}
export interface RemoteRecord {schema: "avlab.remote/0.1"; name: string; url: string; token: string; createdAt: string;}
export interface SyncConflict {conflictId: string; projectId: string; remoteName: string; direction: string; localHeadVersionId: string; remoteHeadVersionId: string; createdAt: string; resolvedAt?: string;}
export interface SyncReceipt {receiptId: string; projectId: string; remoteName: string; operation: "push" | "pull"; startedAt: string; completedAt: string; uploadedObjects: number; downloadedObjects: number; uploadedVersions: number; downloadedVersions: number; uploadedPreviews: number; downloadedPreviews: number; conflictIds: string[];}
export interface SyncResult {uploadedObjects: number; downloadedObjects: number; uploadedVersions: number; downloadedVersions: number; uploadedPreviews: number; downloadedPreviews: number; receiptId?: string; conflicts?: SyncConflict[];}

export interface ReviewAnchor {type: "general" | "preview-time" | "frame" | "object"; timeMs?: number; frame?: number; objectId?: string;}
export interface ReviewRecord {schema: "avlab.review/0.1"; reviewId: string; projectId: string; versionId: string; baseVersionId?: string; title: string; token: string; permissions: Array<"view" | "comment" | "approve" | "download">; requiredApprovals: number; status: "open" | "approved" | "changes-requested" | "rejected" | "closed"; createdAt: string; expiresAt?: string;}
export interface ReviewComment {schema: "avlab.review-comment/0.1"; commentId: string; reviewId: string; author: string; body: string; anchor: ReviewAnchor; parentCommentId?: string; createdAt: string; resolvedAt?: string; resolvedBy?: string;}
export interface ReviewDecision {schema: "avlab.review-decision/0.1"; decisionId: string; reviewId: string; author: string; decision: ReviewDecisionValue; message?: string; createdAt: string;}
export interface ProjectMember {schema: "avlab.member/0.1"; memberId: string; projectId: string; displayName: string; email?: string; role: ProjectRole; status?: "active" | "revoked"; createdAt: string; revokedAt?: string;}
export interface TeamRecord {schema: "avlab.team/0.1"; teamId: string; projectId: string; name: string; memberIds: string[]; createdAt: string;}
export interface ReviewNotification {notificationId: string; projectId: string; reviewId: string; type: "review-comment" | "review-decision" | "review-status"; summary: string; createdAt: string; readAt?: string;}
export interface ActivityEvent {schema: "avlab.activity/0.1"; eventId: string; projectId: string; type: string; actor: string; summary: string; createdAt: string; details: Record<string, unknown>;}
export interface CreativeDivergence {direction: string; parentVersionId?: string; versionIds: string[];}
