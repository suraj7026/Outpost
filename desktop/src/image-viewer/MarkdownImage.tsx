import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, Image } from "lucide-react";
import { call, recordedPreview } from "../api";
import { useEnvironmentConnection } from "../EnvironmentContext";
import { text, type ServerRecord } from "../types";
import { imageKey, imageMime, useArtifactDownload, useArtifactImage } from "./artifact-image";
import { ImageDialog, useImageViewer } from "./ImageViewer";
import ImagePreview from "./ImagePreview";

export default function MarkdownImage({ src, alt, taskId }: { src?: string; alt?: string; taskId: string }) {
  const { records, environmentId } = useEnvironmentConnection();
  const matches = records.filter(record => record.kind === "artifact" && text(record, "taskId") === taskId && imageMime(record) &&
    (src === `#artifact-${record.id}` || src === text(record, "name") || src === `./${text(record, "name")}`));
  if (matches.length === 1) return <AttachedImage key={`${environmentId}:${imageKey(matches[0])}`} record={matches[0]} alt={alt} />;
  let url: URL | undefined;
  try { url = new URL(src || ""); } catch { /* Relative paths must resolve to a task attachment, never the local webview. */ }
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    return <span className="markdown-image-unavailable"><Image size={16} aria-hidden="true" /><span>{alt || "Image"} — unavailable. Use a task attachment or an HTTPS image URL.</span></span>;
  }
  return <ExternalImage key={`${environmentId}:${taskId}:${url.href}`} url={url} alt={alt} />;
}

function AttachedImage({ record, alt }: { record: ServerRecord; alt?: string }) {
  const image = useArtifactImage(record), download = useArtifactDownload(record), open = useImageViewer();
  const name = text(record, "name") || "Image";
  return <ImagePreview name={name} alt={alt} url={image.url} error={recordedPreview() ? undefined : image.error} disabled={recordedPreview() || !download.available}
    placeholder={recordedPreview() ? "Preview unavailable in recorded view" : undefined} onOpen={trigger => open(record, trigger)}
    footer={<><span className="artifact-row"><Image size={15} aria-hidden="true" /><span className="chat-image-name" title={name}>{name}</span>
      <button className="icon-button" aria-label={`Download ${name}`} title={`Download ${name}`} disabled={recordedPreview() || !download.available || download.pending}
        onClick={() => void download.download()}><Download size={15} /></button></span>
      {(download.error || download.saved) && <span className="chat-image-notice" role={download.error ? "alert" : "status"}>{download.error || `Saved to ${download.saved}`}</span>}
    </>} />;
}

function ExternalImage({ url, alt }: { url: URL; alt?: string }) {
  const [consented, setConsented] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const name = alt || url.pathname.split("/").pop() || "External image";
  const preview = recordedPreview();
  const openOriginal = async () => {
    setError("");
    try { await call("open_url", { url: url.href }); }
    catch { setError("Unable to open the original image in your browser."); }
  };
  if (!consented) return <span className="markdown-image-consent">
    <Image size={20} aria-hidden="true" /><span className="markdown-image-details"><span className="chat-image-name" title={name}>{name}</span>
      <span className="chat-image-notice">{preview ? "External images are disabled in recorded view." : `Loading contacts ${url.host}. No cookies or referrer are sent.`}</span></span>
    <button disabled={preview} onClick={(event) => { event.stopPropagation(); setConsented(true); }}>Load image</button>
  </span>;
  return <>
    <ImagePreview name={name} alt={alt} url={url.href} retryable onOpen={trigger => { opener.current = trigger; setOpen(true); }}
      footer={<><span className="artifact-row"><span className="chat-image-name" title={name}>{name}</span>
        <button className="icon-button" title="Open original in browser" aria-label={`Open original ${name}`} onClick={() => void openOriginal()}><ExternalLink size={15} /></button></span>
        <span className="chat-image-notice">{url.host} · External image</span>
        {error && <span className="chat-image-notice error-text" role="alert">{error}</span>}
      </>} />
    {open && createPortal(<ImageDialog imageKey={`${url.href}:${attempt}`} name={name} format={url.host} image={{ url: url.href, error: "", retry: () => setAttempt(value => value + 1) }}
      opener={opener.current} onClose={() => setOpen(false)}
      action={<button className="image-download" onClick={() => void openOriginal()}><ExternalLink size={15} />Open original</button>}
      status={error && <p className="image-download-status" role="alert">{error}</p>} />, document.body)}
  </>;
}
