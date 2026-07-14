import {app, BrowserWindow, dialog, shell} from "electron";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {initProject, openProject} from "@avlab/core";
import {startBridge, type RunningBridge} from "@avlab/local-bridge";

let bridge: RunningBridge | undefined;
let window: BrowserWindow | undefined;

async function selectProject(): Promise<string | undefined> {
  const argumentIndex = process.argv.indexOf("--project");
  if (argumentIndex >= 0) return process.argv[argumentIndex + 1];
  const selection = await dialog.showOpenDialog({
    title: "Choose a music or video project",
    buttonLabel: "Open in AVlab",
    properties: ["openFile", "openDirectory"]
  });
  return selection.canceled ? undefined : selection.filePaths[0];
}

async function ensureProject(target: string): Promise<void> {
  try {
    const existing = await openProject(target);
    existing.database.close();
  } catch {
    const created = await initProject(target);
    created.database.close();
  }
}

async function launch(): Promise<void> {
  const target = await selectProject();
  if (!target) { app.quit(); return; }
  await ensureProject(target);
  const uiDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../desktop/dist");
  bridge = await startBridge({projectPath: target, port: 0, uiDirectory});
  const origin = new URL(bridge.launchUrl).origin;
  window = new BrowserWindow({
    title: "AVlab",
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: "#f5f5f1",
    webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true}
  });
  window.webContents.setWindowOpenHandler(({url}) => {
    if (new URL(url).origin === origin) return {action: "allow"};
    void shell.openExternal(url);
    return {action: "deny"};
  });
  window.webContents.on("will-navigate", event => {
    const destination = new URL(event.url);
    if (destination.origin !== origin) { event.preventDefault(); void shell.openExternal(destination.href); }
  });
  await window.loadURL(bridge.launchUrl);
  if (process.env.AVLAB_SMOKE_TEST === "1") window.webContents.once("did-finish-load", () => setTimeout(() => app.quit(), 250));
}

app.whenReady().then(() => launch().catch(async error => {
  await dialog.showMessageBox({type: "error", title: "AVlab could not open", message: error instanceof Error ? error.message : String(error)});
  app.quit();
}));

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (bridge) void bridge.close(); });
