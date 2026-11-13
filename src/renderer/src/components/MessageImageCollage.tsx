import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { PlacedMessageImage } from "../lib/message-image-placement";
import { Icon } from "./Icon";
import { ModalPortal } from "./ModalPortal";

interface LightboxSlide {
  key: string;
  image: PlacedMessageImage;
  source: string;
}

/** A slide on its way out of the carousel, and which way it leaves. */
interface LeavingSlide {
  key: string;
  towards: 1 | -1;
}

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

interface MessageImageGalleryValue {
  images: PlacedMessageImage[];
  stateOf: (key: string) => LoadState;
  markFailed: (key: string) => void;
  /** Opens the viewer at a photo; `scope` limits it to one item's photos. */
  open: (key: string, scope?: string[]) => void;
  /** Where each photo sits in the reply, so the viewer can zoom from and back to it. */
  registerOrigin: (key: string, element: HTMLElement | null) => void;
}

const MessageImageGalleryContext = createContext<MessageImageGalleryValue | null>(null);

/**
 * Loads the photos a coworker attached to one reply and owns their viewer, so
 * photos placed inside the reply and those in the collage above it open as
 * one carousel. The bytes come from the main process, which downloads only the
 * recorded image; nothing here loads a remote address.
 */
export function MessageImageGallery({
  images,
  children,
}: {
  /** Every photo on the reply, in the order the viewer should step through them. */
  images: PlacedMessageImage[];
  children: ReactNode;
}) {
  const [states, setStates] = useState<Record<string, LoadState>>({});
  const [opened, setOpened] = useState<{ key: string; scope: string[] | null } | null>(null);
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const origins = useRef(new Map<string, HTMLElement>());
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

  const stateOf = useCallback(
    (key: string): LoadState => states[key] ?? { status: "loading" },
    [states],
  );
  const markFailed = useCallback((key: string) => {
    setStates((current) => ({ ...current, [key]: { status: "failed" } }));
  }, []);
  const registerOrigin = useCallback((key: string, element: HTMLElement | null) => {
    if (element) origins.current.set(key, element);
    else origins.current.delete(key);
  }, []);
  const open = useCallback((key: string, scope?: string[]) => {
    setOpened({ key, scope: scope && scope.length > 1 ? scope : null });
  }, []);
  const value = useMemo<MessageImageGalleryValue>(
    () => ({ images, stateOf, markFailed, open, registerOrigin }),
    [images, stateOf, markFailed, open, registerOrigin],
  );

  const ordered = opened?.scope
    ? opened.scope.flatMap((key) => images.filter((image) => imageKey(image) === key))
    : images;
  const slides: LightboxSlide[] = ordered.flatMap((image) => {
    const state = states[imageKey(image)];
    return state?.status === "ready" ? [{ key: imageKey(image), image, source: state.source }] : [];
  });
  const openIndex = opened ? slides.findIndex((slide) => slide.key === opened.key) : -1;

  function close(lastKey: string) {
    setOpened(null);
    origins.current.get(lastKey)?.focus();
  }

  function originRect(key: string): DOMRect | null {
    return origins.current.get(key)?.getBoundingClientRect() ?? null;
  }

  return (
    <MessageImageGalleryContext.Provider value={value}>
      {children}
      {openIndex >= 0 ? (
        <ImageLightbox
          cardRect={originRect}
          initialIndex={openIndex}
          key={opened?.scope ? `scope:${opened.scope.join("|")}` : "all"}
          onClose={close}
          slides={slides}
        />
      ) : null}
    </MessageImageGalleryContext.Provider>
  );
}

/**
 * Photos a coworker attached to a reply but did not place in it, shown as a
 * loose collage above the reply. Inside a gallery it shares that gallery's
 * viewer; on its own it provides one.
 */
export function MessageImageCollage({ images }: { images: PlacedMessageImage[] }) {
  const gallery = useContext(MessageImageGalleryContext);
  if (!gallery) {
    return (
      <MessageImageGallery images={images}>
        <MessageImageCollage images={images} />
      </MessageImageGallery>
    );
  }
  return <CollageCards gallery={gallery} images={images} />;
}

function CollageCards({
  images,
  gallery,
}: {
  images: PlacedMessageImage[];
  gallery: MessageImageGalleryValue;
}) {
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const visible = images.filter((image) => gallery.stateOf(imageKey(image)).status !== "failed");
  if (visible.length === 0) return null;

  return (
    <div
      aria-label={visible.length === 1 ? "Attached image" : `${visible.length} attached images`}
      className={`message-image-collage count-${visible.length}`}
      role="group"
    >
      {visible.map((image) => {
        const key = imageKey(image);
        const state = gallery.stateOf(key);
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
            onClick={() => gallery.open(key)}
            ref={(element) => gallery.registerOrigin(key, element)}
            style={style}
            type="button"
          >
            <img
              alt={image.alt}
              draggable={false}
              onError={() => gallery.markFailed(key)}
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
  );
}

/** Most photos one item shows in the reply; the rest are in its carousel. */
const maxGroupCards = 4;

/**
 * Photos the reply placed at one spot in its own text with
 * `![caption](image:N)`, such as the row of a results table. One photo shows
 * as a thumbnail; several photos of the same item show as a small collage that
 * opens a carousel of just that item. Refs that do not name a photo attached
 * to this reply are dropped, so a reply can never make the app show an image
 * of its own choosing.
 */
export function InlineMessageImages({
  imageRefs,
  captions = [],
}: {
  imageRefs: string[];
  captions?: Array<string | undefined>;
}) {
  const gallery = useContext(MessageImageGalleryContext);
  if (!gallery) return null;
  const photos = imageRefs.flatMap((ref, position) => {
    const image = gallery.images.find((candidate) => candidate.ref === ref);
    if (!image) return [];
    const key = imageKey(image);
    const state = gallery.stateOf(key);
    if (state.status === "failed") return [];
    return [{ key, state, label: captions[position]?.trim() || image.alt }];
  });
  if (photos.length === 0) return null;
  const scope = photos.map((photo) => photo.key);
  const shown = photos.slice(0, maxGroupCards);
  const hidden = photos.length - shown.length;

  const cards = shown.map((photo, position) => {
    const more = hidden > 0 && position === shown.length - 1 ? hidden : 0;
    if (photo.state.status !== "ready") {
      return (
        <span
          aria-label={`Loading image: ${photo.label}`}
          className="chat-inline-image loading"
          key={photo.key}
          role="img"
        />
      );
    }
    return (
      <button
        aria-label={
          photos.length > 1
            ? `View larger: ${photo.label} (${position + 1} of ${photos.length})`
            : `View larger: ${photo.label}`
        }
        className="chat-inline-image"
        key={photo.key}
        onClick={() => gallery.open(photo.key, scope)}
        ref={(element) => gallery.registerOrigin(photo.key, element)}
        type="button"
      >
        <img
          alt={photo.label}
          draggable={false}
          onError={() => gallery.markFailed(photo.key)}
          src={photo.state.source}
        />
        {more > 0 ? (
          <span aria-hidden="true" className="chat-inline-image-more">
            +{more}
          </span>
        ) : null}
      </button>
    );
  });

  if (photos.length === 1) return cards[0] ?? null;
  return (
    <span
      aria-label={`${photos.length} photos`}
      className={`chat-inline-image-group count-${shown.length}`}
      role="group"
    >
      {cards}
    </span>
  );
}

const openDuration = 340;
const closeDuration = 240;
const openEasing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const closeEasing = "cubic-bezier(0.4, 0, 0.2, 1)";
const photoRadius = 14;

function canAnimate(element: HTMLElement): boolean {
  if (typeof element.animate !== "function") return false;
  return !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

function isOnScreen(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

/**
 * Keyframe that makes the full-size photo sit exactly over its collage card:
 * scaled to cover the card and clipped to the card's shape, so animating to
 * "none" reads as the card growing into the viewer.
 */
function cardFrame(photo: DOMRect, card: DOMRect): Keyframe {
  const scale = Math.max(card.width / photo.width, card.height / photo.height);
  const insetX = Math.max(0, (photo.width - card.width / scale) / 2);
  const insetY = Math.max(0, (photo.height - card.height / scale) / 2);
  const dx = card.left + card.width / 2 - (photo.left + photo.width / 2);
  const dy = card.top + card.height / 2 - (photo.top + photo.height / 2);
  return {
    transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
    clipPath: `inset(${insetY}px ${insetX}px round ${16 / scale}px)`,
  };
}

const restingFrame: Keyframe = {
  transform: "none",
  clipPath: `inset(0px 0px round ${photoRadius}px)`,
};

const slideDuration = 460;
const slideEasing = "cubic-bezier(0.22, 1, 0.36, 1)";
const slideGap = 48;

function slideOffset(towards: number): string {
  return `translateX(calc(${towards * 100}% + ${towards * slideGap}px))`;
}

function ImageLightbox({
  slides,
  initialIndex,
  cardRect,
  onClose,
}: {
  slides: LightboxSlide[];
  initialIndex: number;
  cardRect: (key: string) => DOMRect | null;
  onClose: (lastKey: string) => void;
}) {
  // Slides join as photos finish loading, so the shown photo is tracked by key;
  // its position is only remembered for when it drops out.
  const [currentKey, setCurrentKey] = useState(() => slides[initialIndex]?.key ?? null);
  const lastIndex = useRef(initialIndex);
  const [leaving, setLeaving] = useState<LeavingSlide | null>(null);
  const [stepped, setStepped] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef(new Map<string, HTMLDivElement>());
  const photoRefs = useRef(new Map<string, HTMLImageElement>());
  const running = useRef<Animation[]>([]);
  const closing = useRef(false);
  const count = slides.length;
  const found = slides.findIndex((slide) => slide.key === currentKey);
  const index = found >= 0 ? found : Math.min(lastIndex.current, count - 1);
  lastIndex.current = index;
  const current = slides[index];
  const outgoing = leaving ? slides.find((slide) => slide.key === leaving.key) : undefined;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Grow the photo out of the card that was clicked.
  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const photo = current ? photoRefs.current.get(current.key) : undefined;
    if (!current || !photo || !backdrop || !canAnimate(photo)) return;
    backdrop.dataset.phase = "opening";
    let cancelled = false;
    const origin = cardRect(current.key);
    const reveal = () => {
      if (cancelled) return;
      delete backdrop.dataset.phase;
      const target = photo.getBoundingClientRect();
      if (origin && isOnScreen(origin) && target.width > 0 && target.height > 0) {
        photo.animate([cardFrame(target, origin), restingFrame], {
          duration: openDuration,
          easing: openEasing,
        });
      } else {
        photo.animate(
          [
            { opacity: 0, transform: "scale(0.94)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: openDuration, easing: openEasing },
        );
      }
    };
    photo.decode().then(reveal, reveal);
    return () => {
      cancelled = true;
    };
    // Only the photo that opened the viewer zooms; stepping slides instead.
  }, []);

  // Slide the outgoing photo away while the new one follows it in.
  useLayoutEffect(() => {
    if (!leaving || !current || !outgoing) return;
    const incoming = slideRefs.current.get(current.key);
    const departing = slideRefs.current.get(outgoing.key);
    if (!incoming || !departing) {
      setLeaving(null);
      return;
    }
    const timing = { duration: slideDuration, easing: slideEasing };
    const animations = [
      incoming.animate([{ transform: slideOffset(leaving.towards) }, { transform: "none" }], timing),
      departing.animate(
        [{ transform: "none" }, { transform: slideOffset(-leaving.towards) }],
        { ...timing, fill: "forwards" },
      ),
    ];
    running.current = animations;
    let active = true;
    animations[1]?.finished.then(
      () => {
        if (active) setLeaving(null);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [leaving]);

  function goTo(nextIndex: number, towards: 1 | -1) {
    if (closing.current || count < 2 || nextIndex === index) return;
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const element = current ? slideRefs.current.get(current.key) : undefined;
    setLeaving(element && current && canAnimate(element) ? { key: current.key, towards } : null);
    setStepped(true);
    setCurrentKey(slides[nextIndex]?.key ?? null);
  }

  function step(offset: 1 | -1) {
    goTo((index + offset + count) % count, offset);
  }

  function requestClose() {
    if (closing.current || !current) return;
    closing.current = true;
    for (const animation of running.current) animation.finish();
    const photo = photoRefs.current.get(current.key);
    const backdrop = backdropRef.current;
    const done = () => onClose(current.key);
    if (!photo || !backdrop || !canAnimate(photo)) {
      done();
      return;
    }
    backdrop.dataset.phase = "closing";
    const target = photo.getBoundingClientRect();
    const origin = cardRect(current.key);
    const timing = { duration: closeDuration, easing: closeEasing, fill: "forwards" as const };
    const photoAnimation =
      origin && isOnScreen(origin)
        ? photo.animate([restingFrame, cardFrame(target, origin)], timing)
        : photo.animate(
            [
              { opacity: 1, transform: "none" },
              { opacity: 0, transform: "scale(0.94)" },
            ],
            timing,
          );
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    photoAnimation.finished.then(done, done);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function closeFromBackdrop(event: ReactMouseEvent<HTMLElement>) {
    if (event.target === event.currentTarget) requestClose();
  }

  if (!current) return null;
  const shown = outgoing && outgoing.key !== current.key ? [outgoing, current] : [current];

  return (
    <ModalPortal>
      <div
        className="image-lightbox-backdrop"
        onMouseDown={closeFromBackdrop}
        ref={backdropRef}
        role="presentation"
      >
        <button
          aria-label="Close image"
          className="image-lightbox-close"
          onClick={requestClose}
          ref={closeRef}
          type="button"
        >
          <Icon name="close" />
        </button>
        <div
          aria-label="Image viewer"
          aria-modal="true"
          aria-roledescription="carousel"
          className={`image-lightbox${count > 1 ? "" : " single"}`}
          onMouseDown={closeFromBackdrop}
          role="dialog"
        >
          {count > 1 ? (
            <button
              aria-label="Previous image"
              className="image-lightbox-nav previous"
              onClick={() => step(-1)}
              type="button"
            >
              <Icon name="back" />
            </button>
          ) : null}
          <div
            className={`image-lightbox-viewport${leaving ? " sliding" : ""}`}
            onMouseDown={closeFromBackdrop}
          >
            {shown.map((slide) => (
              <LightboxSlideView
                count={count}
                current={slide.key === current.key}
                intro={!stepped}
                key={slide.key}
                onBackdrop={closeFromBackdrop}
                photoRef={(element) => {
                  if (element) photoRefs.current.set(slide.key, element);
                  else photoRefs.current.delete(slide.key);
                }}
                position={slides.indexOf(slide) + 1}
                slide={slide}
                slideRef={(element) => {
                  if (element) slideRefs.current.set(slide.key, element);
                  else slideRefs.current.delete(slide.key);
                }}
              />
            ))}
          </div>
          {count > 1 ? (
            <button
              aria-label="Next image"
              className="image-lightbox-nav next"
              onClick={() => step(1)}
              type="button"
            >
              <Icon name="arrow" />
            </button>
          ) : null}
          {count > 1 ? (
            <div aria-label="Choose image" className="image-lightbox-dots" role="group">
              {slides.map((slide, slideIndex) => (
                <button
                  aria-current={slideIndex === index ? "true" : undefined}
                  aria-label={`Show image ${slideIndex + 1}: ${slide.image.alt}`}
                  key={slide.key}
                  onClick={() => goTo(slideIndex, slideIndex > index ? 1 : -1)}
                  type="button"
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </ModalPortal>
  );
}

function LightboxSlideView({
  slide,
  position,
  count,
  current,
  intro,
  slideRef,
  photoRef,
  onBackdrop,
}: {
  slide: LightboxSlide;
  position: number;
  count: number;
  current: boolean;
  /** True until the first step, so only the opening fades the header in. */
  intro: boolean;
  slideRef: (element: HTMLDivElement | null) => void;
  photoRef: (element: HTMLImageElement | null) => void;
  onBackdrop: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const titleId = useId();
  const { image, source } = slide;
  const host = sourceHost(image.sourceUrl);
  return (
    <div
      aria-hidden={current ? undefined : true}
      aria-labelledby={titleId}
      aria-roledescription="slide"
      className="image-lightbox-slide"
      inert={current ? undefined : true}
      onMouseDown={onBackdrop}
      ref={slideRef}
      role="group"
    >
      <figure className="image-lightbox-figure">
        <figcaption className={`image-lightbox-header${intro ? " intro" : ""}`}>
          <span className="image-lightbox-title" id={titleId}>
            {image.alt}
          </span>
          <span className="image-lightbox-meta">
            {host && image.sourceUrl ? (
              <a href={image.sourceUrl} rel="noreferrer" target="_blank">
                {host}
                <Icon name="open" />
              </a>
            ) : null}
            {count > 1 ? (
              <span aria-live={current ? "polite" : undefined} className="image-lightbox-count">
                {position} of {count}
              </span>
            ) : null}
          </span>
        </figcaption>
        <img
          alt={image.alt}
          className="image-lightbox-photo"
          draggable={false}
          ref={photoRef}
          src={source}
        />
      </figure>
    </div>
  );
}
