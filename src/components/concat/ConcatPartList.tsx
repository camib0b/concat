import { useEffect, useRef, useState, type DragEvent } from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from "lucide-react";
import { useLanguage } from "@camib0b/ui";
import { moveItem } from "@/components/ava/concatReorder";
import {
  fillTemplate,
  formatByteCount,
  formatDuration,
  formatPartIndex,
  splitFileName,
  sumKnownBytes,
  sumKnownDuration,
} from "@/lib/concat/format";
import type { ConcatPartView } from "@/lib/concat/types";

type ConcatPartListProps = {
  parts: readonly ConcatPartView[];
  disabled: boolean;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
};

const MAX_STAGGERED_LANDINGS = 12;
const LANDING_STAGGER_MS = 60;
const LANDING_DURATION_MS = 320;
const ROW_SWAP_MS = 200;
const MOVED_HIGHLIGHT_MS = 700;

const clearButtonClassName = "button-secondary shrink-0";

type SwapSnapshot = {
  id: string;
  top: number;
  left: number;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function landingIndexForHover(fromIndex: number, hoverIndex: number, placeAfter: boolean, partCount: number): number {
  let target = placeAfter ? hoverIndex + 1 : hoverIndex;
  if (fromIndex < target) {
    target -= 1;
  }
  return Math.max(0, Math.min(target, Math.max(0, partCount - 1)));
}

const ConcatPartList = ({ parts, disabled, onMove, onRemove, onClear }: ConcatPartListProps) => {
  const { language, t } = useLanguage();
  const [announcement, setAnnouncement] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);
  const [landingIds, setLandingIds] = useState<readonly string[]>([]);
  const partIdentity = parts.map((part) => part.id).join("\u0000");
  const [previousIdentity, setPreviousIdentity] = useState(partIdentity);
  const dragFromRef = useRef<number | null>(null);
  const dragToRef = useRef<number | null>(null);
  const rowNodes = useRef(new Map<string, HTMLLIElement>());
  const swapGeneration = useRef(0);
  const [movedPartId, setMovedPartId] = useState<string | null>(null);
  const movedHighlightTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (movedHighlightTimer.current !== null) {
        window.clearTimeout(movedHighlightTimer.current);
      }
    };
  }, []);

  if (partIdentity !== previousIdentity) {
    const knownIds = new Set(previousIdentity === "" ? [] : previousIdentity.split("\u0000"));
    const fresh = parts.filter((part) => !knownIds.has(part.id)).map((part) => part.id);
    setPreviousIdentity(partIdentity);
    if (fresh.length > 0 && fresh.length <= MAX_STAGGERED_LANDINGS) {
      setLandingIds(fresh);
    }
  }

  useEffect(() => {
    if (landingIds.length === 0) {
      return;
    }
    const clearAfter = LANDING_DURATION_MS + Math.max(0, landingIds.length - 1) * LANDING_STAGGER_MS + 40;
    const timeoutId = window.setTimeout(() => setLandingIds([]), clearAfter);
    return () => window.clearTimeout(timeoutId);
  }, [landingIds]);

  const totalBytes = sumKnownBytes(parts);
  const totalDuration = sumKnownDuration(parts);
  const totalSizeLabel = totalBytes === null ? "" : formatByteCount(totalBytes, language);
  const totalLengthLabel = totalDuration === null ? "" : formatDuration(totalDuration);
  const visibleTotalSize = totalSizeLabel || "—";
  const visibleTotalLength = totalLengthLabel || "—";
  const countLabel = fillTemplate(parts.length === 1 ? t("concat.parts.one") : t("concat.parts.other"), {
    count: new Intl.NumberFormat(language).format(parts.length),
  });
  const preview = dragFrom !== null && dragTo !== null ? moveItem(parts, dragFrom, dragTo) : parts;
  const visualIndex = new Map(preview.map((part, index) => [part.id, index]));
  const landingOrder = new Map(landingIds.map((id, order) => [id, order]));

  const rememberDrag = (fromIndex: number | null, toIndex: number | null) => {
    dragFromRef.current = fromIndex;
    dragToRef.current = toIndex;
    setDragFrom(fromIndex);
    setDragTo(toIndex);
  };

  const endDrag = () => {
    rememberDrag(null, null);
  };

  const highlightMovedRow = (partId: string) => {
    if (movedHighlightTimer.current !== null) {
      window.clearTimeout(movedHighlightTimer.current);
    }
    setMovedPartId(partId);
    movedHighlightTimer.current = window.setTimeout(() => {
      setMovedPartId((current) => (current === partId ? null : current));
      movedHighlightTimer.current = null;
    }, MOVED_HIGHLIGHT_MS);
  };

  const animateArrowSwap = (snapshots: readonly SwapSnapshot[]) => {
    const generation = ++swapGeneration.current;
    const animated: HTMLLIElement[] = [];
    for (const snapshot of snapshots) {
      const node = rowNodes.current.get(snapshot.id);
      if (!node) {
        continue;
      }
      const deltaX = snapshot.left - node.offsetLeft;
      const deltaY = snapshot.top - node.offsetTop;
      if (deltaX === 0 && deltaY === 0) {
        continue;
      }
      node.style.transition = "none";
      node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      animated.push(node);
    }
    if (animated.length === 0) {
      return;
    }
    // Commit the inverted position before the next frame starts the ease-out.
    animated[0].getBoundingClientRect();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (generation !== swapGeneration.current) {
          return;
        }
        for (const node of animated) {
          node.style.transition = `transform ${ROW_SWAP_MS}ms var(--ease-out-strong)`;
          node.style.transform = "translate(0px, 0px)";
        }
        window.setTimeout(() => {
          if (generation !== swapGeneration.current) {
            return;
          }
          for (const node of animated) {
            node.style.transform = "";
            node.style.transition = "";
          }
        }, ROW_SWAP_MS + 40);
      });
    });
  };

  const movePart = (fromIndex: number, toIndex: number, source: "arrow" | "pointer" = "pointer") => {
    if (disabled || fromIndex === toIndex || toIndex < 0 || toIndex >= parts.length) {
      return;
    }
    const moving = parts[fromIndex];
    if (!moving) {
      return;
    }
    const next = moveItem(parts, fromIndex, toIndex);
    const position = next.findIndex((part) => part.id === moving.id) + 1;
    const announce = () => {
      setAnnouncement(
        fillTemplate(t("concat.part.moved"), {
          name: moving.name.trim() || t("concat.part.untitled"),
          position,
          total: parts.length,
        }),
      );
    };
    if (source !== "arrow") {
      announce();
      onMove(fromIndex, toIndex);
      return;
    }
    const snapshots: SwapSnapshot[] = [];
    if (!prefersReducedMotion()) {
      for (const index of [fromIndex, toIndex]) {
        const part = parts[index];
        const node = part ? rowNodes.current.get(part.id) : undefined;
        if (!part || !node) {
          continue;
        }
        snapshots.push({ id: part.id, top: node.offsetTop, left: node.offsetLeft });
      }
    }
    flushSync(() => {
      announce();
      highlightMovedRow(moving.id);
      onMove(fromIndex, toIndex);
    });
    if (snapshots.length > 0) {
      animateArrowSwap(snapshots);
    }
  };

  const finishDrag = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const fromIndex = dragFromRef.current;
    const toIndex = dragToRef.current;
    endDrag();
    if (fromIndex === null || toIndex === null) {
      return;
    }
    movePart(fromIndex, toIndex);
  };

  return (
    <section aria-labelledby="concat-parts-heading" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="concat-parts-heading" className="text-sm font-medium uppercase tracking-wider text-foreground">
          {t("concat.parts.label")}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {parts.length > 0 ? (
            <button type="button" className={clearButtonClassName} disabled={disabled} onClick={onClear}>
              {t("concat.clear")}
            </button>
          ) : null}
          <p className="font-mono text-xs tabular-nums text-muted-foreground">{countLabel}</p>
        </div>
      </div>
      <p className="mb-3 text-xs tabular-nums leading-5 text-muted-foreground">
        <span title={totalSizeLabel ? undefined : t("concat.part.sizeUnknown")}>
          {fillTemplate(t("concat.summary.size"), { size: visibleTotalSize })}
        </span>{" "}
        <span title={totalLengthLabel ? undefined : t("concat.part.durationUnknown")}>
          {fillTemplate(t("concat.summary.length"), { length: visibleTotalLength })}
        </span>
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {parts.length === 0 ? (
        <p className="border border-border py-6 text-center text-sm text-muted-foreground">{t("concat.parts.empty")}</p>
      ) : (
        <ul
          className="flex max-h-[min(32rem,70vh)] min-w-0 flex-col gap-2 overflow-auto"
          aria-label={t("concat.parts.label")}
        >
          {parts.map((part, index) => {
            const fileName = splitFileName(part.name);
            const formattedSize = part.sizeBytes === null ? "" : formatByteCount(part.sizeBytes, language);
            const formattedDuration = part.durationSeconds === null ? "" : formatDuration(part.durationSeconds);
            const sizeLabel = formattedSize || "—";
            const durationLabel = formattedDuration || "—";
            const shownIndex = visualIndex.get(part.id) ?? index;
            const positionLabel = fillTemplate(t("concat.part.position"), {
              name: part.name.trim() || t("concat.part.untitled"),
              position: shownIndex + 1,
              total: parts.length,
            });
            const isDragSource = dragFrom === index;
            const enteringOrder = landingOrder.get(part.id);
            const rowClassName = [
              "row row-reorderable",
              isDragSource ? "row-placeholder" : "",
              part.id === movedPartId && !isDragSource ? "row-moved" : "",
              enteringOrder !== undefined && !isDragSource ? "row-dropped" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li
                key={part.id}
                ref={(node) => {
                  if (node) {
                    rowNodes.current.set(part.id, node);
                  } else {
                    rowNodes.current.delete(part.id);
                  }
                }}
                className={rowClassName}
                style={{
                  order: dragFrom !== null ? visualIndex.get(part.id) : undefined,
                  animationDelay:
                    enteringOrder !== undefined && !isDragSource
                      ? `${enteringOrder * LANDING_STAGGER_MS}ms`
                      : undefined,
                }}
                aria-label={positionLabel}
                draggable={!disabled}
                onDragStart={(event) => {
                  if (disabled) {
                    event.preventDefault();
                    return;
                  }
                  const target = event.target;
                  if (target instanceof Element && target.closest("button")) {
                    event.preventDefault();
                    return;
                  }
                  const row = event.currentTarget;
                  const rect = row.getBoundingClientRect();
                  const previewNode = row.cloneNode(true) as HTMLElement;
                  previewNode.style.position = "fixed";
                  previewNode.style.top = "-1000px";
                  previewNode.style.left = "0";
                  previewNode.style.width = `${rect.width}px`;
                  previewNode.style.margin = "0";
                  previewNode.style.opacity = "0.65";
                  previewNode.style.pointerEvents = "none";
                  document.body.appendChild(previewNode);
                  previewNode.getBoundingClientRect();
                  event.dataTransfer.setDragImage(
                    previewNode,
                    event.clientX - rect.left,
                    event.clientY - rect.top,
                  );
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", String(index));
                  window.setTimeout(() => previewNode.remove(), 0);
                  rememberDrag(index, index);
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                  if (disabled || dragFromRef.current === null) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  const placeAfter = event.clientY > rect.top + rect.height / 2;
                  const next = landingIndexForHover(dragFromRef.current, index, placeAfter, parts.length);
                  if (dragToRef.current === next) {
                    return;
                  }
                  dragToRef.current = next;
                  setDragTo(next);
                }}
                onDrop={finishDrag}
              >
                <div className="row-body flex min-w-0 flex-1 items-start gap-3">
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                    <GripVertical aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    {formatPartIndex(shownIndex)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline leading-6" dir="auto" title={fileName.title}>
                      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-foreground">
                        {fileName.stem}
                      </span>
                      {fileName.extension ? (
                        <span className="shrink-0 text-sm text-foreground">{fileName.extension}</span>
                      ) : null}
                    </span>
                    {part.state === "reading" ? (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("concat.part.reading")}</p>
                    ) : null}
                    {part.state === "unreadable" ? (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("concat.part.unreadable")}</p>
                    ) : null}
                    <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs leading-5 tabular-nums text-muted-foreground">
                      <span
                        className="shrink-0 whitespace-nowrap"
                        title={formattedSize ? sizeLabel : t("concat.part.sizeUnknown")}
                      >
                        {sizeLabel}
                      </span>
                      <span
                        className="shrink-0 whitespace-nowrap"
                        title={formattedDuration ? durationLabel : t("concat.part.durationUnknown")}
                      >
                        {durationLabel}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="button-icon"
                      aria-label={t("concat.moveUp")}
                      disabled={disabled || dragFrom !== null || index === 0}
                      onClick={() => movePart(index, index - 1, "arrow")}
                    >
                      <ArrowUp aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="button-icon"
                      aria-label={t("concat.moveDown")}
                      disabled={disabled || dragFrom !== null || index === parts.length - 1}
                      onClick={() => movePart(index, index + 1, "arrow")}
                    >
                      <ArrowDown aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="button-icon"
                      aria-label={t("concat.remove")}
                      disabled={disabled || dragFrom !== null}
                      onClick={() => onRemove(part.id)}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default ConcatPartList;
