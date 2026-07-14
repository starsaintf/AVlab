import {afterEach, describe, expect, it} from "vitest";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  attachPreview,
  cloneRemoteProject,
  configureRemote,
  createVersion,
  initProject,
  listSyncConflicts,
  pullRemote,
  pushRemote,
  requestRemoteReview
} from "@avlab/core";
import {startServer, type RunningServer} from "../src/index.js";

const roots:string[]=[];const servers:RunningServer[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>server.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function temp():Promise<string>{const root=await mkdtemp(path.join(os.tmpdir(),"avlab-server-"));roots.push(root);return root;}

describe("Passes 5–7 shared project slice",()=>{
  it("synchronizes a project, clones it, and completes browser review",async()=>{
    const server=await startServer({root:await temp(),token:"studio-secret",port:0});servers.push(server);
    const source=await temp();await writeFile(path.join(source,"film.drp"),"director cut");await writeFile(path.join(source,"preview.mp3"),Buffer.from("ID3 playable proxy"));
    const project=await initProject(source,"Film");const version=await createVersion(project,{message:"Director cut"});await attachPreview(project,version.versionId,path.join(source,"preview.mp3"));
    configureRemote(project,"origin",server.url,"studio-secret");const pushed=await pushRemote(project);expect(pushed.uploadedVersions).toBe(1);expect(pushed.uploadedObjects).toBeGreaterThan(0);
    const destination=await temp();const clone=await cloneRemoteProject(destination,{url:server.url,token:"studio-secret"},project.descriptor.projectId);
    expect(await readFile(path.join(destination,"film.drp"),"utf8")).toBe("director cut");expect(clone.database.listVersions()).toHaveLength(1);expect(clone.database.listPreviews()).toHaveLength(1);
    const requested=await requestRemoteReview(project,{versionId:version.versionId,title:"Review director cut",requiredApprovals:2});
    const token=new URL(requested.reviewUrl).pathname.split("/").at(-1)!;
    const detail=await fetch(`${server.url}/api/public/reviews/${token}`);expect(detail.status).toBe(200);expect((await detail.json() as {review:{title:string}}).review.title).toBe("Review director cut");
    const comment=await fetch(`${server.url}/api/public/reviews/${token}/comments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({author:"Client",body:"Trim the opening",anchor:{type:"preview-time",timeMs:1200}})});expect(comment.status).toBe(200);
    const decision=await fetch(`${server.url}/api/public/reviews/${token}/decision`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({author:"Director",decision:"approve"})});
    expect((await decision.json() as {review:{status:string}}).review.status).toBe("open");
    const duplicate=await fetch(`${server.url}/api/public/reviews/${token}/decision`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({author:"Director",decision:"approve"})});
    expect((await duplicate.json() as {review:{status:string}}).review.status).toBe("open");
    const finalDecision=await fetch(`${server.url}/api/public/reviews/${token}/decision`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({author:"Producer",decision:"approve"})});
    expect((await finalDecision.json() as {review:{status:string}}).review.status).toBe("approved");
    const auth={authorization:"Bearer studio-secret","content-type":"application/json"};
    const memberResponse=await fetch(`${server.url}/api/projects/${project.descriptor.projectId}/members`,{method:"POST",headers:auth,body:JSON.stringify({displayName:"Mix engineer",role:"prepare"})});
    expect(memberResponse.status).toBe(200);
    const memberToken=(await memberResponse.json() as {accessToken:string}).accessToken;
    expect((await fetch(`${server.url}/api/projects/${project.descriptor.projectId}`,{headers:{authorization:`Bearer ${memberToken}`}})).status).toBe(200);
    expect((await fetch(`${server.url}/api/projects/${project.descriptor.projectId}/members`,{method:"POST",headers:{authorization:`Bearer ${memberToken}`,"content-type":"application/json"},body:JSON.stringify({displayName:"Unauthorized",role:"full"})})).status).toBe(403);
    const activity=await (await fetch(`${server.url}/api/projects/${project.descriptor.projectId}/activity`,{headers:{authorization:"Bearer studio-secret"}})).json() as {events:{type:string}[]};
    expect(activity.events.some(event=>event.type==="review.approve")).toBe(true);
    expect(activity.events.some(event=>event.type==="member.added")).toBe(true);
    clone.database.close();project.database.close();
  });

  it("resumes transfers, enforces review permissions, and revokes collaborators",async()=>{
    const serverRoot=await temp();const server=await startServer({root:serverRoot,token:"admin-secret",port:0});servers.push(server);
    const payload=Buffer.from("resumable-object-transfer");const contentId=`sha256:${createHash("sha256").update(payload).digest("hex")}`;
    const first=await fetch(`${server.url}/api/objects/${encodeURIComponent(contentId)}`,{method:"PUT",headers:{authorization:"Bearer admin-secret","content-type":"application/octet-stream","content-range":`bytes 0-8/${payload.length}`},body:payload.subarray(0,9)});
    expect(first.status).toBe(308);
    const second=await fetch(`${server.url}/api/objects/${encodeURIComponent(contentId)}`,{method:"PUT",headers:{authorization:"Bearer admin-secret","content-type":"application/octet-stream","content-range":`bytes 9-${payload.length-1}/${payload.length}`},body:payload.subarray(9)});
    expect(second.status).toBe(200);
    const ranged=await fetch(`${server.url}/api/objects/${encodeURIComponent(contentId)}`,{headers:{authorization:"Bearer admin-secret",range:"bytes=3-8"}});
    expect(ranged.status).toBe(206);expect(Buffer.from(await ranged.arrayBuffer()).toString()).toBe(payload.subarray(3,9).toString());

    const source=await temp();await writeFile(path.join(source,"song.logicx"),"mix");await writeFile(path.join(source,"listen.mp3"),Buffer.from("ID3 review"));
    const project=await initProject(source,"Song");const version=await createVersion(project,{message:"Mix"});await attachPreview(project,version.versionId,path.join(source,"listen.mp3"));
    configureRemote(project,"origin",server.url,"admin-secret");await pushRemote(project);
    const requested=await requestRemoteReview(project,{versionId:version.versionId,permissions:["view"],expiresAt:new Date(Date.now()+60_000).toISOString()});
    const token=new URL(requested.reviewUrl).pathname.split("/").at(-1)!;const detail=await (await fetch(`${server.url}/api/public/reviews/${token}`)).json() as {previews:{previewId:string}[]};
    const previewId=detail.previews[0]!.previewId;
    expect((await fetch(`${server.url}/api/public/reviews/${token}/comments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({body:"No"})})).status).toBe(403);
    expect((await fetch(`${server.url}/api/public/reviews/${token}/downloads/${previewId}`)).status).toBe(403);
    const expired=await requestRemoteReview(project,{versionId:version.versionId,expiresAt:new Date(Date.now()-1_000).toISOString()});
    expect((await fetch(`${server.url}/api/public/reviews/${new URL(expired.reviewUrl).pathname.split("/").at(-1)!}`)).status).toBe(404);

    const auth={authorization:"Bearer admin-secret","content-type":"application/json"};
    const added=await (await fetch(`${server.url}/api/projects/${project.descriptor.projectId}/members`,{method:"POST",headers:auth,body:JSON.stringify({displayName:"Editor",role:"prepare"})})).json() as {member:{memberId:string};accessToken:string};
    expect((await fetch(`${server.url}/api/projects/${project.descriptor.projectId}`,{headers:{authorization:`Bearer ${added.accessToken}`}})).status).toBe(200);
    expect((await fetch(`${server.url}/api/projects/${project.descriptor.projectId}/members/${added.member.memberId}/revoke`,{method:"POST",headers:auth,body:"{}"})).status).toBe(200);
    expect((await fetch(`${server.url}/api/projects/${project.descriptor.projectId}`,{headers:{authorization:`Bearer ${added.accessToken}`}})).status).toBe(401);
    project.database.close();
  });

  it("keeps a local creative direction selected when remote work diverges",async()=>{
    const server=await startServer({root:await temp(),token:"sync-secret",port:0});servers.push(server);
    const seedRoot=await temp();await writeFile(path.join(seedRoot,"track.als"),"base");const seed=await initProject(seedRoot,"Track");const base=await createVersion(seed,{message:"Base"});configureRemote(seed,"origin",server.url,"sync-secret");await pushRemote(seed);
    const aRoot=await temp(),bRoot=await temp();const a=await cloneRemoteProject(aRoot,{url:server.url,token:"sync-secret"},seed.descriptor.projectId);const b=await cloneRemoteProject(bRoot,{url:server.url,token:"sync-secret"},seed.descriptor.projectId);
    await writeFile(path.join(aRoot,"track.als"),"direction A");const aVersion=await createVersion(a,{message:"Direction A",baseVersionId:base.versionId});await pushRemote(a);
    await writeFile(path.join(bRoot,"track.als"),"direction B");const bVersion=await createVersion(b,{message:"Direction B",baseVersionId:base.versionId});const pulled=await pullRemote(b);
    expect(pulled.conflicts).toHaveLength(1);expect(b.database.getHead(b.descriptor.defaultDirection)).toBe(bVersion.versionId);expect(listSyncConflicts(b)[0]).toEqual(expect.objectContaining({localHeadVersionId:bVersion.versionId,remoteHeadVersionId:aVersion.versionId}));
    seed.database.close();a.database.close();b.database.close();
  });

  it("enforces server authentication and retains project activity",async()=>{
    const server=await startServer({root:await temp(),token:"secret",port:0});servers.push(server);
    expect((await fetch(`${server.url}/api/projects/none`)).status).toBe(401);
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });
});
