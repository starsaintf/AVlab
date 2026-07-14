import {afterEach, describe, expect, it} from "vitest";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDirection,
  createProposal,
  createVersion,
  exportProjectBundle,
  findDivergences,
  generatePreview,
  importProjectBundle,
  initProject,
  listDirections,
  listPreviews,
  listProposals
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
async function temp(prefix="avlab-pass-"):Promise<string>{const root=await mkdtemp(path.join(os.tmpdir(),prefix));roots.push(root);return root;}

function wav(durationSeconds=1, sampleRate=8000):Buffer {
  const samples=durationSeconds*sampleRate, dataSize=samples*2, output=Buffer.alloc(44+dataSize);
  output.write("RIFF",0);output.writeUInt32LE(36+dataSize,4);output.write("WAVEfmt ",8);output.writeUInt32LE(16,16);output.writeUInt16LE(1,20);output.writeUInt16LE(1,22);output.writeUInt32LE(sampleRate,24);output.writeUInt32LE(sampleRate*2,28);output.writeUInt16LE(2,32);output.writeUInt16LE(16,34);output.write("data",36);output.writeUInt32LE(dataSize,40);
  for(let i=0;i<samples;i++)output.writeInt16LE(Math.round(Math.sin(i/12)*8000),44+i*2);
  return output;
}

describe("Pass 4 previews",()=>{
  it("generates a browser-playable audio proxy for an immutable version",async()=>{
    const root=await temp();await writeFile(path.join(root,"session.flp"),"native");await writeFile(path.join(root,"rough.wav"),wav());
    const project=await initProject(root);const version=await createVersion(project,{message:"Rough mix"});
    const preview=await generatePreview(project,version.versionId,{maxDurationSeconds:2});
    expect(preview.mediaKind).toBe("audio");expect(preview.mimeType).toBe("audio/mpeg");expect(preview.size).toBeGreaterThan(100);
    expect(preview.profile).toBe("review");expect(preview.metadata?.durationMs).toBeGreaterThan(900);expect(preview.waveformRelativePath).toMatch(/waveform\.png$/);
    expect(listPreviews(project,version.versionId)).toEqual([expect.objectContaining({previewId:preview.previewId})]);
    project.database.close();
  });
});

describe("Pass 7 creative directions",()=>{
  it("preserves alternate work, detects divergence and prepares proposals",async()=>{
    const root=await temp();await writeFile(path.join(root,"song.als"),"base");const project=await initProject(root);
    const base=await createVersion(project,{message:"Approved starting point"});
    createDirection(project,{name:"New hook",baseVersionId:base.versionId});
    await writeFile(path.join(root,"song.als"),"hook A");const a=await createVersion(project,{message:"Hook A",direction:"New hook",baseVersionId:base.versionId});
    await writeFile(path.join(root,"song.als"),"hook B");const b=await createVersion(project,{message:"Hook B",direction:"New hook",baseVersionId:base.versionId});
    expect(a.parentVersionIds).toEqual([base.versionId]);expect(b.parentVersionIds).toEqual([base.versionId]);
    expect(findDivergences(project)).toEqual([expect.objectContaining({direction:"New hook",versionIds:expect.arrayContaining([a.versionId,b.versionId])})]);
    const proposal=createProposal(project,b.versionId,"Choose Hook B");expect(proposal.status).toBe("draft");
    expect(listDirections(project).some(item=>item.name==="New hook")).toBe(true);expect(listProposals(project)[0]?.proposalId).toBe(proposal.proposalId);
    project.database.close();
  });
});

describe("portable collaboration",()=>{
  it("exports and imports complete history, media objects and previews",async()=>{
    const source=await temp(),bundle=await temp("avlab-bundle-"),destination=await temp("avlab-import-");
    await writeFile(path.join(source,"edit.prproj"),"version one");await writeFile(path.join(source,"preview.wav"),wav());
    const project=await initProject(source);const version=await createVersion(project,{message:"First cut"});await generatePreview(project,version.versionId);
    await exportProjectBundle(project,bundle);project.database.close();
    const imported=await importProjectBundle(bundle,destination);
    expect(await readFile(path.join(destination,"edit.prproj"),"utf8")).toBe("version one");
    expect(imported.database.listVersions()).toHaveLength(1);expect(imported.database.listPreviews()).toHaveLength(1);
    imported.database.close();
  });
});
