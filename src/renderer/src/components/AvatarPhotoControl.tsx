import { useEffect, useRef, useState, type ReactNode } from "react";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { avatarPhotoAccept, loadAvatarPhoto } from "../lib/avatar-image";

export function AvatarPhotoControl({
  photo,
  onChange,
  disabled,
  preview,
}: {
  photo: string | null;
  onChange: (photo: string | null) => void | Promise<void>;
  disabled?: boolean;
  preview?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const uploadTrigger = useRef<HTMLButtonElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const removingRef = useRef(false);
  const restoreRemoveFocus = useRef(false);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  function discardBitmap() {
    bitmapRef.current?.close();
    bitmapRef.current = null;
    setBitmap(null);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
      bitmapRef.current?.close();
      bitmapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    requestId.current += 1;
    discardBitmap();
  }, [disabled]);

  useEffect(() => {
    if (!removing && restoreRemoveFocus.current) {
      restoreRemoveFocus.current = false;
      uploadTrigger.current?.focus();
    }
  }, [removing]);

  async function pick(file: File | undefined) {
    if (!file || disabled || removingRef.current) return;
    const currentRequest = ++requestId.current;
    discardBitmap();
    setError(null);
    try {
      const nextBitmap = await loadAvatarPhoto(file);
      if (!mounted.current || currentRequest !== requestId.current || disabled) {
        nextBitmap.close();
        return;
      }
      bitmapRef.current = nextBitmap;
      setBitmap(nextBitmap);
    } catch (photoError) {
      if (mounted.current && currentRequest === requestId.current) {
        setError(photoError instanceof Error ? photoError.message : String(photoError));
      }
    }
  }

  function closeDialog() {
    requestId.current += 1;
    discardBitmap();
    setError(null);
    uploadTrigger.current?.focus();
  }

  async function applyPhoto(nextPhoto: string) {
    await onChange(nextPhoto);
    if (mounted.current) closeDialog();
  }

  async function removePhoto() {
    if (removingRef.current || disabled) return;
    removingRef.current = true;
    requestId.current += 1;
    discardBitmap();
    setRemoving(true);
    setError(null);
    try {
      await onChange(null);
    } catch (photoError) {
      if (mounted.current) setError(photoError instanceof Error ? photoError.message : String(photoError));
    } finally {
      removingRef.current = false;
      if (mounted.current) {
        restoreRemoveFocus.current = true;
        setRemoving(false);
      }
    }
  }

  return (
    <div className="avatar-photo-control">
      {preview ?? (photo ? <img alt="Uploaded photo preview" className="avatar-photo-preview" src={photo} /> : null)}
      <input
        accept={avatarPhotoAccept}
        aria-label="Avatar photo"
        disabled={disabled || removing}
        hidden
        onChange={(event) => {
          void pick(event.target.files?.[0]);
          event.target.value = "";
        }}
        ref={input}
        type="file"
      />
      <div className="avatar-photo-actions">
        <button
          className="secondary-button"
          disabled={disabled || removing}
          onClick={() => input.current?.click()}
          ref={uploadTrigger}
          type="button"
        >
          {photo ? "Replace photo" : "Upload photo"}
        </button>
        {photo ? (
          <button className="text-button" disabled={disabled || removing} onClick={() => void removePhoto()} type="button">
            {removing ? "Removing…" : "Remove photo"}
          </button>
        ) : null}
      </div>
      {error ? <small className="inline-error" role="alert">{error}</small> : null}
      {bitmap ? <AvatarCropDialog bitmap={bitmap} onApply={applyPhoto} onCancel={closeDialog} /> : null}
    </div>
  );
}
