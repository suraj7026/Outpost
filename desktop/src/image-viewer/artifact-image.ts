import { useEffect, useRef, useState } from "react";
import { call, recordedPreview } from "../api";
import { text, type ServerRecord } from "../types";

export function imageMime(record: ServerRecord): string | null {
  const mime = text(record, "mime").split(";")[0].trim().toLowerCase();
  return ["image/png", "image/jpeg", "image/webp"].includes(mime) ? mime : null;
}

export function imageKey(record: ServerRecord): string {
  return JSON.stringify([record.id, text(record, "hash"), imageMime(record)]);
}

export function useArtifactImage(record: ServerRecord, enabled = true) {
  const mime = imageMime(record), hash = text(record, "hash"), key = imageKey(record);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState({ key: "", url: "", error: "" });
  useEffect(() => {
    if (!enabled || !mime || recordedPreview()) return;
    let active = true, url = "";
    setResult({ key, url: "", error: "" });
    void call<string>("artifact", { id: record.id, hash }).then((base64) => {
      if (!active) return;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setResult({ key, url, error: "" });
    }).catch((error) => {
      if (active) setResult({ key, url: "", error: String(error) });
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [record.id, hash, mime, key, enabled, attempt]);
  return {
    url: result.key === key ? result.url : "",
    error: result.key === key ? result.error : "",
    retry: () => setAttempt((value) => value + 1),
  };
}

export function useArtifactDownload(record: ServerRecord) {
  const key = imageKey(record);
  const generation = useRef(0), busy = useRef(false);
  const [result, setResult] = useState({ key, pending: false, saved: "", error: "" });
  useEffect(() => {
    busy.current = false;
    return () => { generation.current++; };
  }, [key]);
  const download = async () => {
    if (recordedPreview() || busy.current) return;
    const ticket = generation.current;
    busy.current = true;
    setResult({ key, pending: true, saved: "", error: "" });
    try {
      const saved = await call<string>("save_artifact", { id: record.id, hash: text(record, "hash"), name: text(record, "name") });
      if (ticket === generation.current) setResult({ key, pending: false, saved, error: "" });
    } catch (error) {
      if (ticket === generation.current) setResult({ key, pending: false, saved: "", error: String(error) });
    } finally {
      if (ticket === generation.current) busy.current = false;
    }
  };
  return { ...(result.key === key ? result : { pending: false, saved: "", error: "" }), download };
}
