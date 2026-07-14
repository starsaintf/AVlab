import React, {useEffect, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";

type Preview = {previewId: string; mediaKind: string; mimeType: string; fileName?: string};
type Comment = {commentId: string; author: string; body: string; createdAt: string; anchor: {type: string; timeMs?: number}; parentCommentId?: string; resolvedAt?: string};
type Decision = {decisionId: string; author: string; decision: string; createdAt: string};
type Detail = {
  review: {title: string; status: string; permissions: string[]};
  version: {message: string};
  baseVersion?: {message: string};
  previews: Preview[];
  basePreviews: Preview[];
  comments: Comment[];
  decisions: Decision[];
};

const token = location.pathname.split("/").filter(Boolean).at(-1) ?? "";

async function call<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(route, {headers: {"content-type": "application/json", ...(init?.headers ?? {})}, ...init});
  const data = await response.json().catch(() => ({})) as {message?: string};
  if (!response.ok) throw new Error(data.message ?? "Could not complete the review action.");
  return data as T;
}

function App(): React.ReactElement {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<string>();
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string>();
  const [mode, setMode] = useState<"proposed" | "previous">("proposed");
  const media = useRef<HTMLMediaElement>(null);

  const load = async () => {
    try { setDetail(await call<Detail>(`/api/public/reviews/${token}`)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  useEffect(() => { void load(); }, []);

  const post = async () => {
    const timeMs = media.current ? Math.round(media.current.currentTime * 1000) : undefined;
    await call(`/api/public/reviews/${token}/comments`, {
      method: "POST",
      body: JSON.stringify({author, body, ...(replyTo ? {parentCommentId: replyTo} : {}), anchor: timeMs !== undefined ? {type: "preview-time", timeMs} : {type: "general"}})
    });
    setBody(""); setReplyTo(undefined); await load();
  };
  const decide = async (decision: string) => {
    await call(`/api/public/reviews/${token}/decision`, {method: "POST", body: JSON.stringify({author, decision})});
    await load();
  };
  const resolve = async (commentId: string) => {
    await call(`/api/public/reviews/${token}/comments/${commentId}/resolve`, {method: "POST", body: JSON.stringify({author})});
    await load();
  };

  if (error) return <main className="error"><h1>Review unavailable</h1><p>{error}</p></main>;
  if (!detail) return <main><h1>Opening review…</h1></main>;
  const chosen = mode === "proposed" ? detail.previews[0] : detail.basePreviews[0];
  const canComment = detail.review.permissions.includes("comment");
  const canApprove = detail.review.permissions.includes("approve");
  const canDownload = detail.review.permissions.includes("download");

  return <main>
    <header><div><p className="eyebrow">AVlab review</p><h1>{detail.review.title}</h1><p>{detail.version.message}</p></div><span className={`badge ${detail.review.status}`}>{detail.review.status.replace("-", " ")}</span></header>
    <section className="player-card">
      <div className="switch"><button className={mode === "proposed" ? "active" : ""} onClick={() => setMode("proposed")}>Proposed version</button><button className={mode === "previous" ? "active" : ""} disabled={!detail.baseVersion} onClick={() => setMode("previous")}>Previous version</button></div>
      {chosen ? chosen.mediaKind === "video" ? <video key={chosen.previewId} ref={media as React.RefObject<HTMLVideoElement>} controls src={`/api/public/reviews/${token}/previews/${chosen.previewId}`}/>
        : chosen.mediaKind === "image" ? <img src={`/api/public/reviews/${token}/previews/${chosen.previewId}`}/>
        : <audio key={chosen.previewId} ref={media as React.RefObject<HTMLAudioElement>} controls src={`/api/public/reviews/${token}/previews/${chosen.previewId}`}/>
        : <div className="empty">No playable preview has been attached to this version.</div>}
      {chosen && canDownload && <a className="download" href={`/api/public/reviews/${token}/downloads/${chosen.previewId}`}>Download this preview</a>}
    </section>
    <div className="grid">
      <section className="card">
        <h2>{replyTo ? "Reply to feedback" : "Leave feedback"}</h2>
        {canComment ? <>
          <input value={author} onChange={event => setAuthor(event.target.value)} placeholder="Your name"/>
          <textarea value={body} onChange={event => setBody(event.target.value)} placeholder="What should change? Your current playback time will be attached."/>
          <button className="primary" disabled={!body.trim()} onClick={() => void post()}>{replyTo ? "Post reply" : "Post feedback"}</button>
          {replyTo && <button onClick={() => setReplyTo(undefined)}>Cancel reply</button>}
        </> : <p className="muted">This link is view-only.</p>}
        {canApprove && <div className="decisions"><button onClick={() => void decide("approve")}>Approve</button><button onClick={() => void decide("request-changes")}>Request changes</button><button onClick={() => void decide("reject")}>Reject</button></div>}
      </section>
      <section className="card"><h2>Conversation</h2>{detail.comments.length ? detail.comments.map(comment => <article key={comment.commentId} className={comment.parentCommentId ? "reply" : ""}>
        <b>{comment.author}</b>{comment.anchor.timeMs !== undefined && <span>{format(comment.anchor.timeMs)}</span>}{comment.resolvedAt && <span>resolved</span>}
        <p>{comment.body}</p>
        {canComment && !comment.resolvedAt && <div><button onClick={() => setReplyTo(comment.commentId)}>Reply</button><button onClick={() => void resolve(comment.commentId)}>Resolve</button></div>}
      </article>) : <p className="muted">No feedback yet.</p>}</section>
    </div>
  </main>;
}

function format(ms: number): string {const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;}
createRoot(document.getElementById("root")!).render(<App/>);
