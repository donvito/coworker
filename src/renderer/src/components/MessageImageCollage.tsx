import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { PlacedMessageImage } from "../lib/message-image-placement";
import { Icon } from "./Icon";
import { ModalPortal } from "./ModalPortal";

type LoadState = { status: "loading" } | { status: "ready"; source: string } | { status: "failed" };

const minimumCardRatio = 0.72;
const maximumCardRatio = 1.6;
const defaultCardRatio = 4 / 3;

function imageKey(image: PlacedMessageImage): string {
  return `${image.setId}:${image.index}`;
}

function cardRatio(width: number | undefined, height: number | undefined): number {
  if (!width || !height) return defaultCardRatio;
  return Math.min(maximumCardRatio, Math.max(minimumCardRatio, width / height));
}

function sourceHost(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" ? url.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/**
 * Photos a coworker attached to a reply, shown as a loose collage above it.
 * The bytes come from the main process, which downloads only the recorded
 * image; nothing here loads a remote address.
 */
export function MessageImageCollage({ images }: { images: PlacedMessageImage[] }) {
  const [states, setStates] = useState<Record<string, LoadState>>({});
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const imageKeys = images.map(imageKey).join("|");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    for (const image of images) {
      const key = imageKey(image);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      window.coworker.messageImages
        .read(image.setId, image.index)
        .then(
          (data): LoadState => ({
            status: "ready",
            source: `data:${data.mimeType};base64,${data.data}`,
          }),
          (): LoadState => ({ status: "failed" }),
        )
        .then((state) => {
          if (mounted.current) setStates((current) => ({ ...current, [key]: state }));
        });
    }
  }, [imageKeys]);

  const visible = images.filter((image) => states[imageKey(image)]?.status !== "failed");
  const viewable = visible.filter((image) => states[imageKey(image)]?.status === "ready");
  if (visible.length === 0) return null;

  const openIndex = openKey ? viewable.findIndex((image) => imageKey(image) === openKey) : -1;
  const openImage = openIndex >= 0 ? viewable[openIndex] : undefined;
  const openState = openImage ? states[imageKey(openImage)] : undefined;

  function close() {
    const key = openKey;
    setOpenKey(null);
    if (key) cardRefs.current.get(key)?.focus();
  }

  function step(offset: number) {
    if (openIndex < 0 || viewable.length < 2) return;
    const next = viewable[(openIndex + offset + viewable.length) % viewable.length];
    if (next) setOpenKey(imageKey(next));
  }

  return (
    <>
      <div
        aria-label={visible.length === 1 ? "Attached image" : `${visible.length} attached images`}
        className={`message-image-collage count-${visible.length}`}
        role="group"
      >
        {visible.map((image) => {
          const key = imageKey(image);
          const state = states[key] ?? { status: "loading" };
          const style = {
            "--card-ratio": String(ratios[key] ?? cardRatio(image.width, image.height)),
          } as CSSProperties;
          if (state.status !== "ready") {
            return (
              <span
                aria-label={`Loading image: ${image.alt}`}
                className="message-image-card loading"
                key={key}
                role="img"
                style={style}
              />
            );
          }
          return (
            <button
              aria-label={`View larger: ${image.alt}`}
              className="message-image-card"
              key={key}
              onClick={() => setOpenKey(key)}
              ref={(element) => {
                if (element) cardRefs.current.set(key, element);
                else cardRefs.current.delete(key);
              }}
              style={style}
              type="button"
            >
              <img
                alt={image.alt}
                draggable={false}
                onError={() =>
                  setStates((current) => ({ ...current, [key]: { status: "failed" } }))
                }
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth > 0 && naturalHeight > 0) {
                    setRatios((current) => ({
                      ...current,
                      [key]: cardRatio(naturalWidth, naturalHeight),
                    }));
                  }
                }}
                src={state.source}
              />
            </button>
          );
        })}
      </div>
      {openImage && openState?.status === "ready" ? (
        <ImageLightbox
          count={viewable.length}
          image={openImage}
          onClose={close}
          onStep={step}
          position={openIndex + 1}
          source={openState.source}
        />
      ) : null}
    </>
  );
}

function ImageLightbox({
  image,
  source,
  position,
  count,
  onClose,
  onStep,
}: {
  image: PlacedMessageImage;
  source: string;
  position: number;
  count: number;
  onClose: () => void;
  onStep: (offset: number) => void;
}) {
  const captionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const host = sourceHost(image.sourceUrl);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") onStep(-1);
      else if (event.key === "ArrowRight") onStep(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <ModalPortal>
      <div className="image-lightbox-backdrop" onMouseDown={onClose} role="presentation">
        <figure
          aria-describedby={captionId}
          aria-label="Image viewer"
          aria-modal="true"
          className="image-lightbox"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <button
            aria-label="Close image"
            className="image-lightbox-close"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <Icon name="close" />
          </button>
          <img alt={image.alt} src={source} />
          <figcaption id={captionId}>
            <span className="image-lightbox-caption">{image.alt}</span>
            <span className="image-lightbox-meta">
              {count > 1 ? (
                <span className="image-lightbox-steps">
                  <button aria-label="Previous image" onClick={() => onStep(-1)} type="button">
                    <Icon name="back" />
                  </button>
                  <span aria-live="polite">
                    {position} of {count}
                  </span>
                  <button aria-label="Next image" onClick={() => onStep(1)} type="button">
                    <Icon name="arrow" />
                  </button>
                </span>
              ) : null}
              {host && image.sourceUrl ? (
                <a href={image.sourceUrl} rel="noreferrer" target="_blank">
                  {host}
                  <Icon name="open" />
                </a>
              ) : null}
            </span>
          </figcaption>
        </figure>
      </div>
    </ModalPortal>
  );
}
