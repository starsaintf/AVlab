import React, {useEffect, useMemo, useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";

type Project = {projectId: string; name: string; capabilityLevel: string; rootKind: string};
type Version = {versionId: string; message: string; createdAt: string; direction: string; kind: string; parentVersionIds: string[]};
type Change = {path: string; change: string};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {credentials: "same-origin", headers: {"content-type": "application/json", ...(init?.headers ?? {})}, ...init});
  const data = await response.json().catch(() => ({})) as {message?: string};
  if (!response.ok) throw new Error(data.message ?? "AVlab could not complete that action.");
  return data as T;
}

function App(): React.ReactElement {
  const [project, setProject] = useState<Project>();
  const [versions, setVersions] = useState<Version[]>([]);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [direction, setDirection] = useState("");
  const [showDirection, setShowDirection] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = async (): Promise<void> => {
    const [projectResult, versionResult] = await Promise.all([
      api<{project: Project; dirty: boolean}>("/api/project"),
      api<{versions: Version[]}>("/api/versions")
    ]);
    setProject(projectResult.project); setDirty(projectResult.dirty); setVersions(versionResult.versions);
  };

  useEffect(() => { void refresh().catch(reason => setError(String(reason))); const id = setInterval(() => void refresh().catch(() => undefined), 5000); return () => clearInterval(id); }, []);

  const save = async (): Promise<void> => run("Saving version", async () => {
    const result = await api<{message: string}>("/api/versions", {method: "POST", body: JSON.stringify({message, ...(direction.trim() ? {direction: direction.trim()} : {})})});
    setMessage(""); setNotice(result.message); await refresh();
  });

  const restore = async (versionId: string): Promise<void> => {
    if (!confirm("Restore this version? Your current files will be replaced, but saved versions remain safe.")) return;
    await run("Restoring project", async () => {
      const result = await api<{message: string}>("/api/restore", {method: "POST", body: JSON.stringify({versionId})});
      setNotice(result.message); await refresh();
    });
  };

  const compare = async (): Promise<void> => run("Finding changes", async () => {
    if (selected.length !== 2) throw new Error("Choose exactly two versions.");
    const ordered = [...selected].map(id => versions.find(version => version.versionId === id)!).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const result = await api<{changes: Change[]}>(`/api/compare?from=${encodeURIComponent(ordered[0]!.versionId)}&to=${encodeURIComponent(ordered[1]!.versionId)}`);
    setChanges(result.changes); setNotice(result.changes.length ? `${result.changes.length} change${result.changes.length === 1 ? "" : "s"} found.` : "These versions contain the same project files.");
  });

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label); setError(undefined); setNotice(undefined);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };

  const savedBytes = useMemo(() => versions.length === 0 ? "No saved versions yet" : `${versions.length} saved version${versions.length === 1 ? "" : "s"}`, [versions.length]);

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">A</span><span>AVlab</span></div>
      <nav><button className="active">Work</button><button>Versions</button><button disabled>Feedback</button><button disabled>Files</button><button disabled>Delivery</button></nav>
      <div className="capability"><span>Compatibility</span><strong>{project?.capabilityLevel ?? "—"}</strong><p>AVlab can safely save and restore this project. Deeper editor understanding arrives through adapters.</p></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">Current project</p><h1>{project?.name ?? "Opening project…"}</h1><p>{savedBytes} · {dirty ? "Unsaved changes detected" : "Current work is safe"}</p></div><div className={`status ${dirty ? "dirty" : "safe"}`}>{dirty ? "Needs a version" : "Up to date"}</div></header>

      <section className="save-card">
        <div><p className="eyebrow">Protect where you are</p><h2>Save this version</h2><p>AVlab stores the project exactly as it is without changing the native DAW or editor file.</p></div>
        <div className="save-controls"><div className="save-form"><input value={message} onChange={event => setMessage(event.target.value)} placeholder="What changed? e.g. New hook and shorter intro" onKeyDown={event => {if (event.key === "Enter") void save();}}/><button className="primary" onClick={() => void save()} disabled={Boolean(busy)}>{busy === "Saving version" ? "Saving…" : "Save version"}</button></div>{showDirection ? <div className="direction-row"><input value={direction} onChange={event => setDirection(event.target.value)} placeholder="Name this direction, e.g. Radio edit"/><button className="link-button" onClick={() => {setShowDirection(false); setDirection("");}}>Cancel</button></div> : <button className="try-direction" onClick={() => setShowDirection(true)}>Try another direction</button>}</div>
      </section>

      {(notice || error) && <div className={error ? "notice error" : "notice"}>{error ?? notice}</div>}

      <section className="versions-section">
        <div className="section-heading"><div><p className="eyebrow">Project history</p><h2>Saved versions</h2></div><button className="secondary" disabled={selected.length !== 2 || Boolean(busy)} onClick={() => void compare()}>What changed</button></div>
        {versions.length === 0 ? <div className="empty"><h3>No versions yet</h3><p>Save the first version before making your next major change.</p></div> : <div className="version-list">
          {versions.map((version, index) => <article className="version" key={version.versionId}>
            <label className="check"><input type="checkbox" checked={selected.includes(version.versionId)} onChange={event => setSelected(current => event.target.checked ? [...current.slice(-1), version.versionId] : current.filter(id => id !== version.versionId))}/><span/></label>
            <div className="version-main"><div className="version-title"><h3>{version.message}</h3>{index === 0 && <span>Latest</span>}</div><p>{new Date(version.createdAt).toLocaleString()} · {version.direction}</p></div>
            <button className="link-button" onClick={() => void restore(version.versionId)} disabled={Boolean(busy)}>Restore</button>
          </article>)}
        </div>}
      </section>

      {changes.length > 0 && <section className="changes"><p className="eyebrow">What changed</p><h2>File-level comparison</h2><div>{changes.map(change => <div className="change" key={`${change.change}-${change.path}`}><span className={`change-kind ${change.change}`}>{change.change}</span><code>{change.path}</code></div>)}</div></section>}
    </main>
    {busy && <div className="busy"><div className="spinner"/><span>{busy}…</span></div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
