import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, Maximize, Minus, Plus, X } from "lucide-react";
import { recordedPreview } from "../api";
import { text, type ServerRecord } from "../types";
import { imageKey, imageMime, useArtifactDownload, useArtifactImage } from "./artifact-image";
import "./image-viewer.css";

const ImageViewerContext = createContext<(record: ServerRecord, trigger: HTMLElement) => void>(() => {});
export const useImageViewer = () => useContext(ImageViewerContext);

export function ImageViewerProvider({ records, children }: { records: ServerRecord[]; children: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const record = records.find((row) => row.kind === "artifact" && row.id === selected && imageMime(row));
  const gallery = record ? records.filter((row) => row.kind === "artifact" && imageMime(row) &&
    (text(record, "taskId") ? text(row, "taskId") === text(record, "taskId") : row.id === record.id))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)) : [];
  const index = gallery.findIndex((row) => row.id === selected);
  useEffect(() => { if (selected && !record) setSelected(null); }, [selected, record]);
  return <ImageViewerContext.Provider value={(image, trigger) => {
    if (recordedPreview() || !imageMime(image)) return;
    opener.current = trigger;
    setSelected(image.id);
  }}>
    {children}
    {record && <ImageViewer record={record} index={index} count={gallery.length} opener={opener.current}
      onClose={() => setSelected(null)}
      onPrevious={() => { if (index > 0) setSelected(gallery[index - 1].id); }}
      onNext={() => { if (index < gallery.length - 1) setSelected(gallery[index + 1].id); }} />}
  </ImageViewerContext.Provider>;
}

function ImageViewer({ record, index, count, opener, onClose, onPrevious, onNext }: {
  record: ServerRecord; index: number; count: number; opener: HTMLElement | null;
  onClose: () => void; onPrevious: () => void; onNext: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return <dialog ref={dialog} className="image-viewer" aria-label="Image viewer"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <ImageSlide key={imageKey(record)} record={record} index={index} count={count}
      onClose={onClose} onPrevious={onPrevious} onNext={onNext} />
  </dialog>;
}

function ImageSlide({ record, index, count, onClose, onPrevious, onNext }: {
  record: ServerRecord; index: number; count: number;
  onClose: () => void; onPrevious: () => void; onNext: () => void;
}) {
  const image = useArtifactImage(record), download = useArtifactDownload(record);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [decodeError, setDecodeError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fit = size ? Math.max(.01, Math.min(1, (viewport.width - 32) / size.width, (viewport.height - 32) / size.height)) : 1;
  const scale = zoom ?? fit;
  const error = image.error || decodeError;
  const ready = Boolean(image.url && size && !error);
  const changeZoom = (value: number) => setZoom(Math.max(.01, Math.min(8, value)));
  useLayoutEffect(() => {
    if (stage.current?.closest<HTMLDialogElement>("dialog")?.open) stage.current.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewport({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = stage.current;
    if (node) node.scrollTo({ left: (node.scrollWidth - node.clientWidth) / 2, top: (node.scrollHeight - node.clientHeight) / 2, behavior: "instant" });
  }, [scale, size]);
  return <div className="image-viewer-content" onKeyDown={(event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); onPrevious(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); onNext(); }
    else if (ready && ["+", "=", "-", "0", "1"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "0") setZoom(null);
      else if (event.key === "1") setZoom(1);
      else changeZoom(scale * (event.key === "-" ? .8 : 1.25));
    }
  }}>
    <header className="image-viewer-header">
      <div className="image-viewer-title"><h2>{text(record, "name") || "Image"}</h2><span>{size ? `${size.width} × ${size.height}` : imageMime(record)?.replace("image/", "").toUpperCase()}</span></div>
      <div className="image-viewer-actions">
        <button className="icon-button" aria-label="Previous image" disabled={index <= 0} onClick={onPrevious}><ChevronLeft size={18} /></button>
        <span className="image-position" aria-live="polite">{index + 1} / {count}</span>
        <button className="icon-button" aria-label="Next image" disabled={index >= count - 1} onClick={onNext}><ChevronRight size={18} /></button>
        <button className="icon-button" aria-label="Close image viewer" onClick={onClose}><X size={19} /></button>
      </div>
    </header>
    <div className="image-stage" ref={stage} tabIndex={0} aria-label="Image canvas" aria-busy={!ready && !error}
      data-dragging={dragging} data-zoom={scale.toFixed(3)}
      onPointerDown={(event) => {
        if (!ready || event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
        const node = event.currentTarget;
        if (node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight) return;
        event.preventDefault();
        node.focus({ preventScroll: true });
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
        node.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
        event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
      }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={() => { if (ready) setZoom(zoom === null ? 1 : null); }}>
      {error ? <div className="image-viewer-state"><p role="alert">Unable to display this image. {error}</p><button onClick={() => { setDecodeError(""); setSize(null); image.retry(); }}>Retry image</button></div> : <>
        {!ready && <p className="image-loading" role="status">Loading image…</p>}
        <div className="image-canvas" style={{ width: Math.max(viewport.width, (size?.width ?? 0) * scale + 32), height: Math.max(viewport.height, (size?.height ?? 0) * scale + 32) }}>
          {image.url && <img src={image.url} alt={text(record, "name") || "Task image"} draggable={false}
            style={{ width: size ? size.width * scale : undefined, height: size ? size.height * scale : undefined, visibility: size ? "visible" : "hidden" }}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setDecodeError("The image is damaged or its format does not match the file.")} />}
        </div>
      </>}
    </div>
    <footer className="image-viewer-toolbar">
      <div className="image-zoom-controls">
        <button className="icon-button" aria-label="Zoom out" disabled={!ready || scale <= .01} onClick={() => changeZoom(scale * .8)}><Minus size={16} /></button>
        <output aria-label="Zoom level">{ready ? `${Math.round(scale * 100)}%` : "—"}</output>
        <button className="icon-button" aria-label="Zoom in" disabled={!ready || scale >= 8} onClick={() => changeZoom(scale * 1.25)}><Plus size={16} /></button>
        <button title="Fit to window (0)" aria-pressed={zoom === null} disabled={!ready} onClick={() => setZoom(null)}><Maximize size={14} />Fit</button>
        <button title="Actual size (1)" aria-pressed={zoom === 1} disabled={!ready} onClick={() => setZoom(1)}>Actual size</button>
      </div>
      <button className="image-download" disabled={download.pending || recordedPreview()} onClick={() => void download.download()}><Download size={15} />{download.pending ? "Saving…" : "Download"}</button>
    </footer>
    {(download.error || download.saved) && <p className="image-download-status" role={download.error ? "alert" : "status"}>{download.error || `Saved to ${download.saved}`}</p>}
  </div>;
}
