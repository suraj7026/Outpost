import { useEffect, useRef, useState } from "react";
import { Download, File, Image } from "lucide-react";
import ImagePreview from "./ImagePreview";
import { recordedPreview } from "../api";
import { text, type ServerRecord } from "../types";
import { imageKey, imageMime, useArtifactDownload, useArtifactImage } from "./artifact-image";
import { useImageViewer } from "./ImageViewer";

export default function Artifact({ record }: { record: ServerRecord }) {
  return <ArtifactContent key={imageKey(record)} record={record} />;
}

function ArtifactContent({ record }: { record: ServerRecord }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
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
  const footer = <span className="artifact-row">
      {supported ? <Image size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}
      {supported ? <button className="artifact-name" title={name} aria-label={`Open ${name}`} disabled={preview || !download.available} onClick={(event) => open(record, event.currentTarget)}>{name}</button> : <span>{name}</span>}
      <button className="icon-button" aria-label={`Download ${name}`} title={`Download ${name}`} disabled={preview || !download.available || download.pending} onClick={() => void download.download()}><Download size={15} /></button>
    </span>;
  return <div className="artifact" ref={container}>
    {supported ? <ImagePreview name={name} url={image.url} error={preview ? undefined : image.error}
      disabled={preview || !download.available} placeholder={preview ? "Preview unavailable in recorded view" : undefined}
      onOpen={trigger => open(record, trigger)} footer={footer} /> : footer}
    {download.saved && <p className="small" role="status">Saved to {download.saved}</p>}
    {download.error && <p className="small error-text" role="alert">{download.error}</p>}
  </div>;
}
