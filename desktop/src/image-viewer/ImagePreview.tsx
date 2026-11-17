import { useState, type CSSProperties, type ReactNode } from "react";
import { Image } from "lucide-react";

export type ImagePreviewProps = {
  name: string;
  alt?: string;
  url: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
  retryable?: boolean;
  footer: ReactNode;
};

export default function ImagePreview({ name, alt, url, error, placeholder, disabled, onOpen, retryable, footer }: ImagePreviewProps) {
  const [loaded, setLoaded] = useState<{ url: string; width: number; height: number } | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const size = loaded?.url === url ? loaded : null;
  const [attempt, setAttempt] = useState(0);
  const failed = Boolean(error || decodeError === url);
  const ready = Boolean(size && !failed);
  const width = size ? Math.max(160, Math.min(size.width, 560, size.width / size.height * 360)) : 360;
  return <span className="chat-image" style={{ "--image-width": `${width}px` } as CSSProperties}>
    <button className="artifact-preview" aria-label={`${failed && retryable ? "Retry" : "View"} ${name}`} disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (failed && retryable) { setDecodeError(null); setLoaded(null); setAttempt(value => value + 1); }
        else onOpen(event.currentTarget);
      }}>
      {url && !failed && <img key={`${url}:${attempt}`} src={url} alt={alt || name} draggable={false} decoding="async"
        referrerPolicy="no-referrer" crossOrigin="anonymous" style={{ display: ready ? "block" : "none" }}
        onLoad={(event) => setLoaded({ url, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setDecodeError(url)} />}
      {!ready && <span className="chat-image-state" role="status"><Image size={20} aria-hidden="true" />
        <span>{failed ? retryable ? "Unable to load image. The site may block image sharing. Click to retry." : "Open image to retry" : placeholder || "Loading image…"}</span>
      </span>}
    </button>
    <span className="chat-image-footer">{footer}</span>
  </span>;
}
