import {afterEach, describe, expect, it} from "vitest";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {initProject} from "@avlab/core";
import {startBridge, type RunningBridge} from "../src/index.js";

const roots: string[] = [];
const bridges: RunningBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

async function setup(): Promise<{root: string; ui: string}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "avlab-bridge-")); roots.push(root);
  const ui = await mkdtemp(path.join(os.tmpdir(), "avlab-ui-")); roots.push(ui);
  await writeFile(path.join(root, "project.flp"), "first");
  const project = await initProject(root); project.database.close();
  await writeFile(path.join(ui, "index.html"), "<!doctype html><title>AVlab</title><h1>AVlab</h1>");
  return {root, ui};
}

async function connect(bridge: RunningBridge): Promise<{base: string; cookie: string}> {
  const session = await fetch(bridge.launchUrl, {redirect: "manual"});
  expect(session.status).toBe(302);
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  return {base: new URL(bridge.launchUrl).origin, cookie};
}

describe("local creator bridge", () => {
  it("protects operations with a local session and exposes creator actions", async () => {
    const {root, ui} = await setup();
    const bridge = await startBridge({projectPath: root, port: 0, uiDirectory: ui, automaticRecovery: false}); bridges.push(bridge);
    const base = new URL(bridge.launchUrl).origin;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/project`)).status).toBe(401);
    const {cookie} = await connect(bridge);
    const projectResponse = await fetch(`${base}/api/project`, {headers: {cookie}});
    expect(projectResponse.status).toBe(200);
    expect((await projectResponse.json() as {project: {name: string}}).project.name).toBe(path.basename(root));

    const saveOne = await fetch(`${base}/api/versions`, {method: "POST", headers: {cookie, "content-type": "application/json"}, body: JSON.stringify({message: "First version"})});
    expect(saveOne.status).toBe(200);
    await writeFile(path.join(root, "project.flp"), "second");
    const saveTwo = await fetch(`${base}/api/versions`, {method: "POST", headers: {cookie, "content-type": "application/json"}, body: JSON.stringify({message: "Second version"})});
    expect(saveTwo.status).toBe(200);
    const versions = await (await fetch(`${base}/api/versions`, {headers: {cookie}})).json() as {versions: {versionId: string}[]};
    expect(versions.versions).toHaveLength(2);
    const compare = await fetch(`${base}/api/compare?from=${versions.versions[1]!.versionId}&to=${versions.versions[0]!.versionId}`, {headers: {cookie}});
    expect((await compare.json() as {changes: unknown[]}).changes).toHaveLength(1);
    expect(await (await fetch(`${base}/`)).text()).toContain("AVlab");
  });

  it("marks externally changed project files as needing a new version", async () => {
    const {root, ui} = await setup();
    const bridge = await startBridge({projectPath: root, port: 0, uiDirectory: ui, automaticRecovery: false}); bridges.push(bridge);
    const {base, cookie} = await connect(bridge);
    await writeFile(path.join(root, "project.flp"), "changed outside AVlab");
    await new Promise(resolve => setTimeout(resolve, 1200));
    const result = await (await fetch(`${base}/api/project`, {headers: {cookie}})).json() as {dirty: boolean};
    expect(result.dirty).toBe(true);
  });

  it("creates quiet recovery points after project changes", async () => {
    const {root, ui} = await setup();
    const bridge = await startBridge({projectPath: root, port: 0, uiDirectory: ui, automaticRecovery: true, recoveryDelayMs: 100}); bridges.push(bridge);
    const {base, cookie} = await connect(bridge);
    await writeFile(path.join(root, "project.flp"), "recovery change");
    await new Promise(resolve => setTimeout(resolve, 1400));
    const result = await (await fetch(`${base}/api/versions?all=true`, {headers: {cookie}})).json() as {versions: {kind: string}[]};
    expect(result.versions.some(version => version.kind === "recovery")).toBe(true);
  });
});
