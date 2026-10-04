import { useEffect, useId, useRef, useState } from "react";
import { ModalPortal } from "./ModalPortal";
import { avatarCropFor, avatarCropToDataUrl, avatarPhotoBackground, type AvatarCrop } from "../lib/avatar-image";

export function AvatarCropDialog({
  bitmap,
  onApply,
  onCancel,
}: {
  bitmap: ImageBitmap;
  onApply: (photo: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const initialCenter = { x: bitmap.width / 2, y: bitmap.height / 2 };
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState(initialCenter);
  const [crop, setCrop] = useState<AvatarCrop>(() => avatarCropFor(bitmap.width, bitmap.height, 1, initialCenter));
  const [error, setError] = useState<string | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const titleId = useId();
  const viewRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    viewRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!applyingRef.current) onCancel();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [onCancel]);

  useEffect(() => {
    const view = viewRef.current;
    const preview = previewRef.current;
    if (!view || !preview) return;
    setPreviewReady(false);
    try {
      for (const canvas of [view, preview]) {
        canvas.width = 360;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image preview is unavailable.");
        context.fillStyle = avatarPhotoBackground;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
      }
      setError(null);
      setPreviewReady(true);
    } catch (drawError) {
      setError(drawError instanceof Error ? drawError.message : "Image preview is unavailable.");
    }
  }, [bitmap, crop]);

  function updateZoom(nextZoom: number) {
    const nextCrop = avatarCropFor(bitmap.width, bitmap.height, nextZoom, center);
    setZoom(Math.max(1, Math.min(3, nextZoom)));
    setCrop(nextCrop);
    setCenter({ x: nextCrop.x + nextCrop.size / 2, y: nextCrop.y + nextCrop.size / 2 });
    setError(null);
  }

  function moveCrop(dx: number, dy: number) {
    const nextCenter = { x: center.x + dx, y: center.y + dy };
    const nextCrop = avatarCropFor(bitmap.width, bitmap.height, zoom, nextCenter);
    setCrop(nextCrop);
    setCenter({ x: nextCrop.x + nextCrop.size / 2, y: nextCrop.y + nextCrop.size / 2 });
  }

  async function apply() {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    try {
      await onApply(avatarCropToDataUrl(bitmap, crop));
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : String(cropError));
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  return (
    <ModalPortal>
      <div
        className="modal-backdrop avatar-crop-backdrop"
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget && !applyingRef.current) onCancel();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <section
          aria-labelledby={titleId}
          aria-modal="true"
          className="modal-card avatar-crop-dialog"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Tab") {
              const controls = panelRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
              );
              if (!controls?.length) return;
              const first = controls[0]!;
              const last = controls[controls.length - 1]!;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <header className="modal-header">
            <div>
              <p className="eyebrow">Profile photo</p>
              <h2 id={titleId}>Crop photo</h2>
            </div>
          </header>
          <div className="avatar-crop-workspace">
            <div className="avatar-crop-view-wrap">
              <canvas
                aria-disabled={applying}
                aria-label="Position photo"
                className="avatar-crop-view"
                onKeyDown={(event) => {
                  if (applyingRef.current) return;
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const amount = crop.size * (event.shiftKey ? 0.1 : 0.02);
                  const direction: [number, number] = event.key === "ArrowLeft" ? [amount, 0]
                    : event.key === "ArrowRight" ? [-amount, 0]
                      : event.key === "ArrowUp" ? [0, amount] : [0, -amount];
                  moveCrop(direction[0], direction[1]);
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (event.button !== 0 || applyingRef.current) return;
                  event.currentTarget.focus();
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Synthetic pointer events and some embedded runtimes do not expose capture.
                  }
                  dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (!drag || drag.pointerId !== event.pointerId || applyingRef.current) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (rect.width <= 0) return;
                  const factor = crop.size / rect.width;
                  moveCrop((drag.x - event.clientX) * factor, (drag.y - event.clientY) * factor);
                  dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
                }}
                onPointerUp={(event) => {
                  if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
                }}
                onPointerCancel={() => { dragRef.current = null; }}
                onLostPointerCapture={() => { dragRef.current = null; }}
                ref={viewRef}
                role="img"
                tabIndex={0}
              />
              <p className="avatar-crop-instructions">Drag to position · Arrow keys move the photo · Hold Shift for larger steps</p>
            </div>
            <div className="avatar-crop-preview-column">
              <canvas aria-label="Circular avatar preview" className="avatar-crop-preview" ref={previewRef} role="img" />
              <span>Preview</span>
            </div>
          </div>
          <label className="avatar-crop-zoom">
            <span>Zoom</span>
            <input
              disabled={applying}
              max="3"
              min="1"
              onChange={(event) => updateZoom(Number(event.currentTarget.value))}
              step="0.01"
              type="range"
              value={zoom}
            />
            <output>{zoom.toFixed(2)}×</output>
          </label>
          {error ? <small className="inline-error avatar-crop-error" role="alert">{error}</small> : null}
          <footer className="modal-actions">
            <button className="secondary-button" disabled={applying} onClick={onCancel} type="button">Cancel</button>
            <button className="primary-button" disabled={!previewReady || applying} onClick={() => void apply()} type="button">
              {applying ? "Applying…" : "Apply crop"}
            </button>
          </footer>
        </section>
      </div>
    </ModalPortal>
  );
}
