import { useEffect, useRef, useState } from "react";
import { Download, File, Image } from "lucide-react";
import { recordedPreview } from "../api";
import { text, type ServerRecord } from "../types";
import { imageKey, imageMime, useArtifactDownload, useArtifactImage } from "./artifact-image";
import { useImageViewer } from "./ImageViewer";

export default function Artifact({ record }: { record: ServerRecord }) {
  return <ArtifactContent key={imageKey(record)} record={record} />;
}

function ArtifactContent({ record }: { record: ServerRecord }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [decodeError, setDecodeError] = useState(false);
  const supported = Boolean(imageMime(record)), preview = recordedPreview();
  const image = useArtifactImage(record, supported && visible);
  const download = useArtifactDownload(record);
  const open = useImageViewer();
  const name = text(record, "name") || "Unnamed file";
  useEffect(() => {
    if (!supported || preview || !container.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "120px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [supported, preview]);
  return <div className="artifact" ref={container}>
    {supported && <button className="artifact-preview" aria-label={`View ${name}`} disabled={preview} onClick={(event) => open(record, event.currentTarget)}>
      {image.url && !decodeError ? <img src={image.url} alt="" onError={() => setDecodeError(true)} /> : <span><Image size={19} />{preview ? "Preview unavailable in recorded view" : image.error || decodeError ? "Open image to retry" : "Open image"}</span>}
    </button>}
    <div className="artifact-row">
      <File size={15} />
      {supported ? <button className="artifact-name" aria-label={`Open ${name}`} disabled={preview} onClick={(event) => open(record, event.currentTarget)}>{name}</button> : <span>{name}</span>}
      <button className="icon-button" aria-label={`Download ${name}`} disabled={preview || download.pending} onClick={() => void download.download()}><Download size={15} /></button>
    </div>
    {download.saved && <p className="small" role="status">Saved to {download.saved}</p>}
    {download.error && <p className="small error-text" role="alert">{download.error}</p>}
  </div>;
}
