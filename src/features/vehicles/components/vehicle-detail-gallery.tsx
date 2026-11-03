"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Images, X, ZoomIn } from "lucide-react";

/* ─────────────────────────── types ──────────────────────────── */

type VehicleDetailGalleryProps = Readonly<{
  name: string;
  /** Full-resolution image URLs. May be empty — fallback is shown automatically. */
  images: readonly string[];
  /** Override lightbox stacking when gallery is nested inside another modal. */
  lightboxZClassName?: string;
}>;

/* ─────────────────────────── shared styling ─────────────────── */

/* Tonal plate: cut-out product shots read as objects on a surface, not floating. */
const photoPlateClass =
  "bg-[linear-gradient(155deg,var(--ink-50)_0%,var(--surface-sunken)_58%,var(--ink-100)_100%)]";

/* Circular hairline control that fills on hover. */
const arrowClass =
  "absolute top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface-card)]/90 text-[var(--ink-800)] shadow-[var(--elev-2)] backdrop-blur-md transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:border-[var(--line-strong)] hover:bg-[var(--surface-card)] hover:text-[var(--ink-950)] hover:shadow-[var(--elev-3)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-500)] focus-visible:ring-offset-2";

/* Same control on the dark lightbox backdrop. */
const modalArrowClass =
  "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white backdrop-blur-md transition-[background-color,border-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:border-white/40 hover:bg-white/25 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-0";

/* ─────────────────────────── modal ──────────────────────────── */

function ModalGallery({
  images,
  name,
  startIndex,
  onClose,
  lightboxZClassName = "z-[200]",
}: {
  images: readonly string[];
  name: string;
  startIndex: number;
  onClose: () => void;
  lightboxZClassName?: string;
}) {
  const [current, setCurrent] = useState(startIndex);

  const prev = useCallback(
    () => setCurrent((i) => (i === 0 ? images.length - 1 : i - 1)),
    [images.length],
  );
  const next = useCallback(
    () => setCurrent((i) => (i === images.length - 1 ? 0 : i + 1)),
    [images.length],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", handler, true);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.body.style.overflow = "";
    };
  }, [onClose, prev, next]);

  const src = images[current];

  return (
    <div
      role="dialog"
      aria-modal
      aria-label={`${name} — full gallery`}
      className={`grain fixed inset-0 ${lightboxZClassName} flex flex-col bg-[color-mix(in_srgb,var(--surface-inverse)_95%,transparent)] backdrop-blur-md`}
    >
      {/* header */}
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--line-inverse)] px-4 py-3 text-white/70">
        <span data-numeric className="type-spec">
          {name} — {current + 1} / {images.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close gallery"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition-[background-color,border-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:border-white/40 hover:bg-white/25 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* main image */}
      <div className="relative flex-1 overflow-hidden">
        {src ? (
          <Image
            key={src}
            src={src}
            alt={`${name} — photo ${current + 1}`}
            fill
            className="object-contain"
            sizes="100vw"
            priority
          />
        ) : (
          <div className="type-spec flex h-full items-center justify-center text-white/40">
            Image unavailable
          </div>
        )}

        {images.length > 1 ? (
          <>
            <button
              type="button"
              onClick={prev}
              aria-label="Previous photo"
              className={`${modalArrowClass} left-3`}
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next photo"
              className={`${modalArrowClass} right-3`}
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        ) : null}
      </div>

      {/* thumbnail strip */}
      {images.length > 1 ? (
        <div className="shrink-0 overflow-x-auto border-t border-[var(--line-inverse)] px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex gap-2">
            {images.map((img, i) => (
              <button
                key={img || i}
                type="button"
                onClick={() => setCurrent(i)}
                aria-label={`Photo ${i + 1}`}
                className={[
                  "relative h-14 w-20 shrink-0 overflow-hidden rounded-[var(--r-field)] transition-[opacity,box-shadow,transform] duration-[var(--dur-fast)] ease-[var(--ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-inverse)]",
                  i === current
                    ? "opacity-100 shadow-[inset_0_0_0_2px_var(--orange-400)]"
                    : "opacity-40 shadow-[inset_0_0_0_1px_var(--line-inverse)] hover:opacity-80 motion-safe:hover:-translate-y-0.5",
                ].join(" ")}
              >
                <Image
                  src={img}
                  alt=""
                  fill
                  sizes="80px"
                  className="object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── main export ────────────────────── */

export function VehicleDetailGallery({
  name,
  images,
  lightboxZClassName,
}: VehicleDetailGalleryProps) {
  const safeImages = useMemo(() => images ?? [], [images]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [mainLoaded, setMainLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStart, setModalStart] = useState(0);

  // Reset active index whenever the images array changes
  // (e.g. vehicle data updated after initial render).
  useEffect(() => {
    queueMicrotask(() => {
      setActiveIdx(0);
      setMainLoaded(false);
    });
  }, [safeImages]);

  const openModal = (index: number) => {
    setModalStart(index);
    setModalOpen(true);
  };

  /* ── empty state ─────────────────────────────────────────── */
  if (safeImages.length === 0) {
    return (
      <div
        className={`relative aspect-[4/3] overflow-hidden rounded-[var(--r-panel)] shadow-[inset_0_0_0_1px_var(--line-subtle),var(--elev-2)] ${photoPlateClass}`}
      >
        <div className="type-spec flex h-full items-center justify-center text-[var(--text-faint)]">
          Images coming soon
        </div>
      </div>
    );
  }

  const mainSrc = safeImages[activeIdx] ?? safeImages[0]!;
  const thumbs = safeImages.slice(0, 8);
  const extraCount = safeImages.length - thumbs.length;

  return (
    <>
      {/* ════════════════════════════════════════════════════════
          MAIN IMAGE
          Fills its column — aspect-ratio gives Next.js
          <Image fill> a calculable height.
      ════════════════════════════════════════════════════════ */}
      <div
        className={`relative overflow-hidden rounded-[var(--r-panel)] shadow-[inset_0_0_0_1px_var(--line-subtle),var(--elev-3)] ${photoPlateClass}`}
      >
        {/* aspect-ratio wrapper — guarantees height is never 0 */}
        <div className="relative aspect-[4/3]">
          {/* skeleton — fades out once image loads */}
          <div
            aria-hidden
            className={[
              "skeleton absolute inset-0 transition-opacity duration-[var(--dur-slow)] ease-[var(--ease-out-expo)]",
              mainLoaded ? "opacity-0" : "opacity-100",
            ].join(" ")}
          />

          <Image
            key={mainSrc}
            src={mainSrc}
            alt={`${name} — main photo`}
            fill
            sizes="(max-width: 768px) 100vw, 55vw"
            className={[
              /* Crossfade only — no scale, so the subject never drifts between frames. */
              "object-contain transition-opacity duration-[var(--dur-slow)] ease-[var(--ease-out-expo)]",
              mainLoaded ? "opacity-100" : "opacity-0",
            ].join(" ")}
            priority
            onLoad={() => setMainLoaded(true)}
          />

          {/* hover zoom overlay — clicking opens modal */}
          <button
            type="button"
            onClick={() => openModal(activeIdx)}
            aria-label="View full photo"
            className="group absolute inset-0 flex items-center justify-center bg-[linear-gradient(to_top,rgb(10_20_32/0.30),transparent_45%)] opacity-0 transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--blue-500)]"
          >
            <span className="type-spec flex items-center gap-2 rounded-full border border-white/25 bg-[var(--surface-inverse)]/60 px-4 py-2.5 text-white backdrop-blur-md">
              <ZoomIn className="h-4 w-4" aria-hidden />
              View full size
            </span>
          </button>

          {/* mobile prev / next arrows */}
          {safeImages.length > 1 ? (
            <>
              <button
                type="button"
                onClick={() =>
                  setActiveIdx((i) => (i === 0 ? safeImages.length - 1 : i - 1))
                }
                aria-label="Previous photo"
                className={`${arrowClass} left-3 sm:hidden`}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveIdx((i) => (i === safeImages.length - 1 ? 0 : i + 1))
                }
                aria-label="Next photo"
                className={`${arrowClass} right-3 sm:hidden`}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          ) : null}

          {/* photo counter badge */}
          {safeImages.length > 1 ? (
            <span
              data-numeric
              className="type-spec absolute bottom-3 right-3 rounded-full border border-white/25 bg-[var(--surface-inverse)]/60 px-2.5 py-1.5 text-white backdrop-blur-md sm:hidden"
            >
              {activeIdx + 1} / {safeImages.length}
            </span>
          ) : null}

          {/* "Show all photos" pill — always visible on desktop */}
          <button
            type="button"
            onClick={() => openModal(activeIdx)}
            className="type-spec absolute bottom-3 right-3 hidden items-center gap-1.5 rounded-full border border-white/60 bg-white/85 px-3.5 py-2 text-[var(--ink-800)] shadow-[var(--elev-2)] backdrop-blur-md transition-[background-color,box-shadow,transform] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-white hover:shadow-[var(--elev-3)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-500)] focus-visible:ring-offset-2 sm:flex"
          >
            <Images className="h-3.5 w-3.5" aria-hidden />
            Show all photos
          </button>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════
          THUMBNAIL STRIP
          Always visible — clicking selects main image.
      ════════════════════════════════════════════════════════ */}
      {safeImages.length > 1 ? (
        <div className="mt-3 flex gap-2.5 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {thumbs.map((src, i) => (
            <button
              key={src || i}
              type="button"
              onClick={() => setActiveIdx(i)}
              aria-label={`Photo ${i + 1}`}
              aria-pressed={i === activeIdx}
              className={[
                `relative h-16 w-24 shrink-0 overflow-hidden rounded-[var(--r-field)] transition-[opacity,box-shadow,transform] duration-[var(--dur-base)] ease-[var(--ease-out-expo)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-500)] focus-visible:ring-offset-2 sm:h-20 sm:w-28 ${photoPlateClass}`,
                i === activeIdx
                  ? "opacity-100 shadow-[inset_0_0_0_2px_var(--orange-400),var(--elev-2)]"
                  : "opacity-65 shadow-[inset_0_0_0_1px_var(--line-subtle)] hover:opacity-100 hover:shadow-[inset_0_0_0_1px_var(--line),var(--elev-2)] motion-safe:hover:-translate-y-0.5",
              ].join(" ")}
            >
              <Image
                src={src}
                alt={`${name} — thumbnail ${i + 1}`}
                fill
                sizes="(max-width: 640px) 96px, 112px"
                className="object-cover"
                loading={i === 0 ? "eager" : "lazy"}
              />
            </button>
          ))}

          {/* overflow button */}
          {extraCount > 0 ? (
            <button
              type="button"
              onClick={() => openModal(thumbs.length)}
              className="type-spec relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-field)] bg-[var(--surface-inverse)] text-white transition-[background-color,box-shadow,transform] duration-[var(--dur-base)] ease-[var(--ease-out-expo)] hover:bg-[var(--ink-800)] hover:shadow-[var(--elev-3)] motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-500)] focus-visible:ring-offset-2 sm:h-20 sm:w-28"
            >
              <span data-numeric>+{extraCount} more</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* mobile dot indicators */}
      {safeImages.length > 1 ? (
        <div className="mt-2 flex justify-center gap-1.5 sm:hidden">
          {safeImages.slice(0, 10).map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveIdx(i)}
              aria-label={`Go to photo ${i + 1}`}
              className={[
                "h-1.5 rounded-full transition-[width,background-color] duration-[var(--dur-base)] ease-[var(--ease-out-expo)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-500)] focus-visible:ring-offset-2",
                i === activeIdx
                  ? "w-5 bg-[var(--orange-400)]"
                  : "w-1.5 bg-[var(--ink-300)]",
              ].join(" ")}
            />
          ))}
        </div>
      ) : null}

      {/* modal */}
      {modalOpen ? (
        <ModalGallery
          images={safeImages}
          name={name}
          startIndex={modalStart}
          onClose={() => setModalOpen(false)}
          lightboxZClassName={lightboxZClassName}
        />
      ) : null}
    </>
  );
}
