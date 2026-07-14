import type {CompareResult, CreativeDivergence, DirectionRecord, ProposalRecord, ProposalStatus} from "@avlab/contracts";
import {AvlabError} from "./errors.js";
import {newId} from "./ids.js";
import {compareVersions} from "./compare.js";
import type {OpenProject} from "./project.js";

export interface CreateDirectionInput {
  name: string;
  baseVersionId?: string;
  createdBy?: string;
}

export function createDirection(project: OpenProject, input: CreateDirectionInput): DirectionRecord {
  const name = input.name.trim();
  if (!name) throw new AvlabError("AVLAB_DIRECTION_NAME_REQUIRED", "Give this creative direction a name.");
  if (project.database.getDirection(name)) throw new AvlabError("AVLAB_DIRECTION_EXISTS", `A direction named “${name}” already exists.`);
  const baseVersionId = input.baseVersionId ?? project.database.getHead(project.descriptor.defaultDirection);
  if (baseVersionId && !project.database.hasVersion(baseVersionId)) throw new AvlabError("AVLAB_VERSION_NOT_FOUND", `Saved version not found: ${baseVersionId}`);
  const direction: DirectionRecord = {
    schema: "avlab.direction/0.1",
    projectId: project.descriptor.projectId,
    name,
    ...(baseVersionId ? {baseVersionId, headVersionId: baseVersionId} : {}),
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy ?? "local-human",
    archived: false
  };
  project.database.addDirection(direction);
  return direction;
}

export function ensureDefaultDirection(project: OpenProject): DirectionRecord {
  const existing = project.database.getDirection(project.descriptor.defaultDirection);
  if (existing) return existing;
  const head = project.database.getHead(project.descriptor.defaultDirection);
  const direction: DirectionRecord = {
    schema: "avlab.direction/0.1",
    projectId: project.descriptor.projectId,
    name: project.descriptor.defaultDirection,
    ...(head ? {headVersionId: head, baseVersionId: head} : {}),
    createdAt: project.descriptor.createdAt,
    createdBy: "system",
    archived: false
  };
  project.database.addDirection(direction);
  return direction;
}

export function listDirections(project: OpenProject): DirectionRecord[] {
  ensureDefaultDirection(project);
  return project.database.listDirections();
}

export function createProposal(project: OpenProject, versionId: string, title?: string, createdBy = "local-human"): ProposalRecord {
  const version = project.database.getVersion(versionId);
  if (!version) throw new AvlabError("AVLAB_VERSION_NOT_FOUND", `Saved version not found: ${versionId}`);
  const proposal: ProposalRecord = {
    schema: "avlab.proposal/0.1",
    proposalId: newId("prp"),
    projectId: project.descriptor.projectId,
    versionId,
    title: title?.trim() || version.message,
    status: "draft",
    createdAt: new Date().toISOString(),
    createdBy
  };
  project.database.addProposal(proposal);
  return proposal;
}

export function updateProposal(project: OpenProject, proposalId: string, update: {status?: ProposalStatus; reviewId?: string; reviewUrl?: string}): ProposalRecord {
  const current = project.database.getProposal(proposalId);
  if (!current) throw new AvlabError("AVLAB_PROPOSAL_NOT_FOUND", `Proposal not found: ${proposalId}`);
  const next: ProposalRecord = {...current, ...update};
  project.database.addProposal(next);
  return next;
}

export function listProposals(project: OpenProject): ProposalRecord[] { return project.database.listProposals(); }

export async function compareProposal(project: OpenProject, proposalId: string): Promise<CompareResult> {
  const proposal = project.database.getProposal(proposalId);
  if (!proposal) throw new AvlabError("AVLAB_PROPOSAL_NOT_FOUND", `Proposal not found: ${proposalId}`);
  const version = project.database.getVersion(proposal.versionId);
  if (!version) throw new AvlabError("AVLAB_VERSION_NOT_FOUND", `Saved version not found: ${proposal.versionId}`);
  const baseVersionId = version.parentVersionIds[0] ?? getApprovedVersion(project);
  if (!baseVersionId) throw new AvlabError("AVLAB_PROPOSAL_BASE_NOT_FOUND", "This proposal has no earlier saved version to compare against.");
  return await compareVersions(project, baseVersionId, version.versionId);
}

export function setApprovedVersion(project: OpenProject, versionId: string): void {
  if (!project.database.hasVersion(versionId)) throw new AvlabError("AVLAB_VERSION_NOT_FOUND", `Saved version not found: ${versionId}`);
  project.database.setSetting("approvedVersionId", versionId);
}

export function getApprovedVersion(project: OpenProject): string | undefined {
  return project.database.getSetting<string>("approvedVersionId");
}

export function findDivergences(project: OpenProject): CreativeDivergence[] {
  const groups = new Map<string, string[]>();
  for (const version of project.database.listVersions(true)) {
    const parent = version.parentVersionIds[0] ?? "";
    const key = `${version.direction}\u0000${parent}`;
    const list = groups.get(key) ?? [];
    list.push(version.versionId);
    groups.set(key, list);
  }
  const output: CreativeDivergence[] = [];
  for (const [key, versionIds] of groups) {
    if (versionIds.length < 2) continue;
    const [direction, parentVersionId] = key.split("\u0000");
    output.push({direction: direction!, ...(parentVersionId ? {parentVersionId} : {}), versionIds});
  }
  return output;
}
