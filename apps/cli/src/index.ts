#!/usr/bin/env node
import {Command} from "commander";
import {
  AvlabError,
  compareVersions,
  createVersion,
  garbageCollect,
  initProject,
  openProject,
  replicateObjects,
  restoreVersion,
  setStorage,
  storageStatus,
  verifyProject,
  type OpenProject
} from "@avlab/core";

const program = new Command();
program.name("avlab").description("Save, protect and restore audiovisual project versions.").version("0.1.0");

program.command("init")
  .description("Connect a file or folder to AVlab")
  .argument("<path>")
  .option("--name <name>")
  .action(async (target, options) => withProjectClose(await initProject(target, options.name), project => {
    print({message: "Project connected to AVlab.", project: project.descriptor});
  }));

program.command("save")
  .description("Save a safe project version")
  .argument("<path>")
  .option("-m, --message <message>", "Describe this version")
  .option("-d, --direction <direction>", "Save into another creative direction")
  .option("--recovery", "Create a quiet recovery point")
  .action(async (target, options) => withOpened(target, async project => {
    const version = await createVersion(project, {message: options.message, direction: options.direction, kind: options.recovery ? "recovery" : "named"});
    print({message: options.recovery ? "Recovery point created." : "Version saved.", version});
  }));

program.command("versions")
  .description("Show saved versions")
  .argument("<path>")
  .option("--all", "Include quiet recovery points")
  .action(async (target, options) => withOpened(target, project => print(project.database.listVersions(Boolean(options.all)))));

program.command("restore")
  .description("Restore a saved version")
  .argument("<path>")
  .argument("<version-id>")
  .action(async (target, versionId) => withOpened(target, async project => {
    await restoreVersion(project, versionId);
    print({message: "Project restored.", versionId});
  }));

program.command("compare")
  .description("Show what changed between two versions")
  .argument("<path>")
  .argument("<from-version>")
  .argument("<to-version>")
  .action(async (target, from, to) => withOpened(target, project => compareVersions(project, from, to).then(print)));

program.command("status")
  .description("Check local project storage")
  .argument("<path>")
  .action(async target => withOpened(target, project => storageStatus(project).then(print)));

program.command("verify")
  .description("Verify that every saved project piece is intact")
  .argument("<path>")
  .action(async target => withOpened(target, project => verifyProject(project).then(result => {
    print(result);
    if (!result.ok) process.exitCode = 2;
  })));

program.command("clean")
  .description("Remove stored pieces no saved version needs")
  .argument("<path>")
  .action(async target => withOpened(target, project => garbageCollect(project).then(print)));

program.command("copy-storage")
  .description("Copy stored project pieces to another disk or network location")
  .argument("<path>")
  .argument("<destination>")
  .action(async (target, destination) => withOpened(target, project => replicateObjects(project, destination).then(print)));

program.command("use-storage")
  .description("Use another disk or network location for future project pieces")
  .argument("<path>")
  .argument("<location>")
  .option("--quota <bytes>", "Maximum bytes allowed", value => Number(value))
  .action(async (target, location, options) => withOpened(target, async project => {
    await setStorage(project, location, options.quota);
    print({message: "Storage location updated. Reopen AVlab before saving another version.", location});
  }));

program.command("bridge")
  .description("Start the local creator interface")
  .argument("<path>")
  .option("--port <port>", "Port to use", value => Number(value), 4317)
  .action(async (target, options) => {
    const {startBridge} = await import("@avlab/local-bridge");
    const running = await startBridge({projectPath: target, port: options.port});
    console.log(`AVlab is ready at ${running.launchUrl}`);
  });

program.parseAsync().catch(error => {
  const avlabError = error instanceof AvlabError ? error : new AvlabError("AVLAB_UNEXPECTED", error instanceof Error ? error.message : String(error));
  console.error(JSON.stringify({error: avlabError.code, message: avlabError.message, details: avlabError.details}, null, 2));
  process.exitCode = 1;
});

async function withOpened<T>(target: string, run: (project: Awaited<ReturnType<typeof openProject>>) => Promise<T> | T): Promise<T> {
  const project = await openProject(target);
  return withProjectClose(project, run);
}

async function withProjectClose<T>(project: OpenProject, run: (project: OpenProject) => Promise<T> | T): Promise<T> {
  try { return await run(project); }
  finally { project.database.close(); }
}

function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
