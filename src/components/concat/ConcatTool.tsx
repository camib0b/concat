import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { useLanguage } from "@camib0b/ui";
import { moveItem } from "@/components/ava/concatReorder";
import ConcatPartList from "@/components/concat/ConcatPartList";
import {
  isConcatListDataMode,
  partsForConcatListDataMode,
  type ConcatListDataMode,
} from "@/components/concat/concatPartListFixtures";
import { detectConcatCapacity, pickJoinedFile } from "@/lib/concat/capacity";
import { compareParts, convertTargetFor } from "@/lib/concat/compatibility";
import { fillTemplate, formatByteCount, formatJoinDuration, singleLineFileName } from "@/lib/concat/format";
import { concatErrorCode, detectBrowserFamily, reportConcatEvent, type ConcatJoinOutcome } from "@/lib/concat/telemetry";
import { isConcatCancelled, type ConcatPartView, type PartDifference, type ProbedPart } from "@/lib/concat/types";
import type { TranslationKey } from "@/i18n/types";

type ListedPart = {
  id: string;
  file: File;
  probe: ProbedPart | null;
  unreadable: boolean;
};

type JoinPhase =
  | { kind: "idle" }
  | { kind: "running"; progress: number }
  | { kind: "saved"; name: string; durationMilliseconds: number }
  | { kind: "download"; url: string; name: string; durationMilliseconds: number }
  | { kind: "failed" };

const JOINED_DOWNLOAD_NAME = "joined.mp4";

const resultMessageClassName = "min-w-0 text-sm leading-6 text-foreground [overflow-wrap:anywhere]";

const primaryButtonClassName = "button-primary";

const PARTS_HEADING_GAP_PX = 16;

function scrollPartsHeadingBelowHeader(): void {
  const heading = document.getElementById("concat-parts-heading");
  if (!(heading instanceof HTMLElement)) {
    return;
  }
  const header = document.querySelector("header");
  let offset = PARTS_HEADING_GAP_PX;
  if (header instanceof HTMLElement) {
    const position = window.getComputedStyle(header).position;
    if (position === "sticky" || position === "fixed") {
      offset += header.getBoundingClientRect().height;
    }
  }
  heading.style.scrollMarginTop = `${offset}px`;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;
  const previousRootScrollBehavior = root.style.scrollBehavior;
  const previousBodyScrollBehavior = document.body.style.scrollBehavior;
  if (reduceMotion) {
    root.style.scrollBehavior = "auto";
    document.body.style.scrollBehavior = "auto";
  }
  heading.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  if (reduceMotion) {
    root.style.scrollBehavior = previousRootScrollBehavior;
    document.body.style.scrollBehavior = previousBodyScrollBehavior;
  }
}

const secondaryButtonClassName = "button-secondary";

const SUCCESS_TOAST_DISMISS_MS = 6000;

type SuccessToast = {
  id: number;
  destination: "downloaded" | "saved";
  name: string;
};

function dragHasFiles(dataTransfer: DataTransfer): boolean {
  const types = dataTransfer.types;
  if (!types) {
    return false;
  }
  for (const type of types) {
    if (type === "Files") {
      return true;
    }
  }
  return false;
}

const DATA_MODE_LABELS: Record<ConcatListDataMode, string> = {
  live: "Live",
  demo: "Demo data",
  worst: "Worst case",
  empty: "Empty",
  one: "One",
  many: "1,000",
};

function differenceKey(difference: PartDifference): TranslationKey {
  switch (difference) {
    case "codec":
      return "concat.difference.codec";
    case "resolution":
      return "concat.difference.resolution";
    case "frameRate":
      return "concat.difference.frameRate";
    case "timebase":
      return "concat.difference.timebase";
    case "audio":
      return "concat.difference.audio";
    case "keyframe":
      return "concat.difference.keyframe";
  }
}

function toView(part: ListedPart): ConcatPartView {
  if (part.unreadable) {
    return {
      id: part.id,
      name: part.file.name,
      sizeBytes: part.file.size,
      durationSeconds: null,
      state: "unreadable",
    };
  }
  if (!part.probe) {
    return {
      id: part.id,
      name: part.file.name,
      sizeBytes: part.file.size,
      durationSeconds: null,
      state: "reading",
    };
  }
  return {
    id: part.id,
    name: part.file.name,
    sizeBytes: part.file.size,
    durationSeconds: part.probe.durationSeconds,
    state: "ready",
  };
}

const ConcatListDataToggle = ({
  mode,
  onChange,
}: {
  mode: ConcatListDataMode;
  onChange: (mode: ConcatListDataMode) => void;
}) => {
  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap gap-1 bg-neutral-200 p-1"
      style={{ fontFamily: "system-ui, sans-serif" }}
    >
      {(Object.keys(DATA_MODE_LABELS) as ConcatListDataMode[]).map((option) => {
        const selected = option === mode;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option)}
            className="px-2 py-1 text-xs text-neutral-800"
            style={{ background: selected ? "#fff" : "transparent" }}
          >
            {DATA_MODE_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
};

const ConcatTool = () => {
  const { language, t } = useLanguage();
  const inputId = useId();
  const [searchParams, setSearchParams] = useSearchParams();
  const capacity = useMemo(() => detectConcatCapacity(), []);
  const [parts, setParts] = useState<ListedPart[]>([]);
  const [phase, setPhase] = useState<JoinPhase>({ kind: "idle" });
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [successToast, setSuccessToast] = useState<SuccessToast | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const progressStamp = useRef(0);
  const successToastId = useRef(0);
  const scrollPartsAfterImport = useRef(false);
  const requestedMode = searchParams.get("data");
  const listDataMode: ConcatListDataMode =
    import.meta.env.DEV && isConcatListDataMode(requestedMode) ? requestedMode : "live";
  const [fixtureParts, setFixtureParts] = useState<ConcatPartView[] | null>(() =>
    import.meta.env.DEV && listDataMode !== "live" ? partsForConcatListDataMode(listDataMode) : null,
  );

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    if (listDataMode === "live") {
      setFixtureParts(null);
      return;
    }
    setFixtureParts(partsForConcatListDataMode(listDataMode));
  }, [listDataMode]);

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!scrollPartsAfterImport.current) {
      return;
    }
    scrollPartsAfterImport.current = false;
    scrollPartsHeadingBelowHeader();
  }, [parts]);

  useEffect(() => {
    if (!successToast) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setSuccessToast((current) => (current?.id === successToast.id ? null : current));
    }, SUCCESS_TOAST_DISMISS_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [successToast]);

  const setListDataMode = (mode: ConcatListDataMode) => {
    if (!import.meta.env.DEV) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (mode === "live") {
      next.delete("data");
    } else {
      next.set("data", mode);
    }
    setSearchParams(next, { replace: true });
  };

  const running = phase.kind === "running";
  const viewingFixture = import.meta.env.DEV && listDataMode !== "live" && fixtureParts !== null;
  const liveViews = parts.map(toView);
  const displayedParts = viewingFixture && fixtureParts ? fixtureParts : liveViews;

  const probes = parts.map((part) => part.probe);
  const allProbed = parts.length > 0 && parts.every((part) => part.probe !== null || part.unreadable);
  const anyUnreadable = parts.some((part) => part.unreadable);
  const anyReading = parts.some((part) => !part.probe && !part.unreadable);
  const readyProbes = probes.filter((probe): probe is ProbedPart => probe !== null && probe.readable && probe.video !== null);
  const differences: PartDifference[] =
    !viewingFixture && allProbed && !anyUnreadable && !anyReading && readyProbes.length === parts.length
      ? compareParts(readyProbes)
      : [];
  const totalBytes = parts.reduce((sum, part) => sum + part.file.size, 0);
  const overMemoryLimit = capacity.mode === "memory" && totalBytes > capacity.limitBytes;
  const canDirectJoin =
    !viewingFixture &&
    !running &&
    parts.length >= 2 &&
    allProbed &&
    !anyUnreadable &&
    !anyReading &&
    differences.length === 0 &&
    !overMemoryLimit;
  const canConvert =
    !viewingFixture &&
    !running &&
    parts.length >= 2 &&
    allProbed &&
    !anyUnreadable &&
    !anyReading &&
    differences.length > 0 &&
    (capacity.mode === "streaming" || !overMemoryLimit);

  const limitLabel = capacity.mode === "memory" ? formatByteCount(capacity.limitBytes, language) : "";

  const releaseDownload = () => {
    if (!downloadUrlRef.current) {
      return;
    }
    URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = null;
  };

  const forgetResult = () => {
    releaseDownload();
    setPhase((current) => (current.kind === "running" ? current : { kind: "idle" }));
  };

  const addFiles = (fileList: FileList | readonly File[]) => {
    if (running || viewingFixture) {
      return;
    }
    const additions: ListedPart[] = Array.from(fileList).map((file) => ({
      id: crypto.randomUUID(),
      file,
      probe: null,
      unreadable: false,
    }));
    if (additions.length === 0) {
      return;
    }
    forgetResult();
    scrollPartsAfterImport.current = true;
    setParts((current) => [...current, ...additions]);
    void (async () => {
      const { probeVideoFile } = await import("@/lib/concat/probe");
      await Promise.all(
        additions.map(async (addition) => {
          const probe = await probeVideoFile(addition.file);
          setParts((current) =>
            current.map((part) =>
              part.id === addition.id
                ? { ...part, probe, unreadable: !probe.readable || probe.video === null }
                : part,
            ),
          );
        }),
      );
    })();
  };

  const moveDisplayed = (fromIndex: number, toIndex: number) => {
    if (running) {
      return;
    }
    if (viewingFixture) {
      setFixtureParts((current) => (current ? moveItem(current, fromIndex, toIndex) : current));
      return;
    }
    forgetResult();
    setParts((current) => moveItem(current, fromIndex, toIndex));
  };

  const removeDisplayed = (id: string) => {
    if (running) {
      return;
    }
    if (viewingFixture) {
      setFixtureParts((current) => (current ? current.filter((part) => part.id !== id) : current));
      return;
    }
    forgetResult();
    setParts((current) => current.filter((part) => part.id !== id));
  };

  const clearDisplayed = () => {
    if (running) {
      return;
    }
    if (viewingFixture) {
      setFixtureParts([]);
      return;
    }
    forgetResult();
    setParts([]);
  };

  const runJoin = async (mode: "copy" | "convert") => {
    if (running || viewingFixture) {
      return;
    }
    const attemptStartedAt = performance.now();
    let measuredFrom = attemptStartedAt;
    const inputBytes = parts.reduce((sum, part) => sum + part.file.size, 0);
    const partCount = parts.length;
    const partsMatched = differences.length === 0;
    const converted = mode === "convert";
    const joinPath = capacity.mode === "streaming" ? "stream" : "memory";
    const outputBytes = { bytes: 0 };
    let outcome: ConcatJoinOutcome = "error";
    let errorCode = "failed";
    let successDestination: "downloaded" | "saved" | null = null;
    const controller = new AbortController();
    abortRef.current = controller;
    progressStamp.current = 0;
    setSuccessToast(null);
    let writable: FileSystemWritableFileStream | null = null;
    let savedFileName = JOINED_DOWNLOAD_NAME;
    let durationMilliseconds: number | null = null;
    const measureDuration = (): number => {
      const measured = durationMilliseconds ?? Math.max(0, Math.round(performance.now() - measuredFrom));
      durationMilliseconds = measured;
      return measured;
    };
    try {
      if (capacity.mode === "streaming") {
        const picked = await pickJoinedFile();
        if (!picked) {
          errorCode = "missing-save";
          setPhase({ kind: "failed" });
          return;
        }
        writable = picked.writable;
        savedFileName = singleLineFileName(picked.name, JOINED_DOWNLOAD_NAME);
      }
      measuredFrom = performance.now();
      releaseDownload();
      setPhase({ kind: "running", progress: 0 });
      const { joinParts } = await import("@/lib/concat/joinParts");
      const blob = await joinParts({
        files: parts.map((part) => part.file),
        mode,
        streaming: capacity.mode === "streaming",
        writable,
        hasAudio: parts.map((part) => part.probe?.audio !== null && part.probe?.audio !== undefined),
        target: convertTargetFor(readyProbes),
        signal: controller.signal,
        onProgress: (ratio) => {
          const now = performance.now();
          if (ratio < 1 && now - progressStamp.current < 200) {
            return;
          }
          progressStamp.current = now;
          setPhase({ kind: "running", progress: ratio });
        },
        outputBytes,
      });
      if (controller.signal.aborted) {
        outcome = "cancelled";
        errorCode = "";
        setPhase({ kind: "idle" });
        return;
      }
      if (blob) {
        const url = URL.createObjectURL(blob);
        downloadUrlRef.current = url;
        const downloadName = singleLineFileName(JOINED_DOWNLOAD_NAME, JOINED_DOWNLOAD_NAME);
        setPhase({
          kind: "download",
          url,
          name: downloadName,
          durationMilliseconds: measureDuration(),
        });
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = downloadName;
        anchor.click();
        outcome = "success";
        errorCode = "";
        successDestination = "downloaded";
        savedFileName = downloadName;
      } else {
        setPhase({
          kind: "saved",
          name: savedFileName,
          durationMilliseconds: measureDuration(),
        });
        outcome = "success";
        errorCode = "";
        successDestination = "saved";
      }
    } catch (error) {
      if (isConcatCancelled(error)) {
        outcome = "cancelled";
        errorCode = "";
        setPhase((current) => (current.kind === "running" ? { kind: "idle" } : current));
        return;
      }
      console.error(error);
      outcome = "error";
      errorCode = concatErrorCode(error);
      setPhase({ kind: "failed" });
      if (writable) {
        try {
          await writable.abort();
        } catch {
          // The writer may already have closed the file.
        }
      }
    } finally {
      const reportedDuration = measureDuration();
      reportConcatEvent({
        browser: detectBrowserFamily(),
        path: joinPath,
        matched: partsMatched,
        converted,
        partCount,
        inputBytes,
        outputBytes: outputBytes.bytes,
        durationMs: reportedDuration,
        outcome,
        errorCode,
      });
      if (outcome === "success" && successDestination) {
        successToastId.current += 1;
        setSuccessToast({
          id: successToastId.current,
          destination: successDestination,
          name: savedFileName,
        });
      }
    }
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    if (!dragHasFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setDraggingFiles(false);
    addFiles(event.dataTransfer.files);
  };

  const joinSucceeded = phase.kind === "saved" || phase.kind === "download";
  const percent = phase.kind === "running" ? Math.round(phase.progress * 100) : joinSucceeded ? 100 : 0;
  const joinedLabel =
    phase.kind === "saved" || phase.kind === "download"
      ? fillTemplate(t("concat.progress.done"), {
          duration: formatJoinDuration(phase.durationMilliseconds, language),
        })
      : "";

  return (
    <div className="space-y-8">
      <p className="text-sm leading-6 text-muted-foreground">{t("concat.privacy")}</p>
      <p className="text-sm leading-6 text-foreground">
        {capacity.mode === "streaming"
          ? t("concat.capacity.streaming")
          : fillTemplate(t("concat.capacity.memory"), { limit: limitLabel })}
      </p>

      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          if (!dragHasFiles(event.dataTransfer)) {
            return;
          }
          event.preventDefault();
          if (!running && !viewingFixture) {
            setDraggingFiles(true);
          }
        }}
        onDragLeave={() => setDraggingFiles(false)}
        onDrop={onDrop}
        className={`drop-zone${draggingFiles ? " is-drag-over" : ""}`}
      >
        <input
          id={inputId}
          type="file"
          multiple
          accept="video/*,.mp4,.mov,.m4v,.mkv,.webm,.ts,.mts,.m2ts"
          disabled={running || viewingFixture}
          className="drop-zone-input"
          onChange={(event) => {
            if (event.currentTarget.files) {
              addFiles(event.currentTarget.files);
            }
            event.currentTarget.value = "";
          }}
        />
        <span className="block text-sm text-foreground">{t("concat.drop")}</span>
        <span className={`button-file${running || viewingFixture ? " is-disabled" : ""}`}>
          {displayedParts.length > 0 ? t("concat.choose.more") : t("concat.choose")}
        </span>
      </label>
      <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{t("concat.formats")}</p>

      <ConcatPartList
        parts={displayedParts}
        disabled={running}
        onMove={moveDisplayed}
        onRemove={removeDisplayed}
        onClear={clearDisplayed}
      />

      {!viewingFixture && parts.length === 1 && !running ? (
        <p className="text-sm text-muted-foreground">{t("concat.needTwo")}</p>
      ) : null}
      {!viewingFixture && anyUnreadable ? (
        <p className="text-sm text-muted-foreground">{t("concat.removeUnreadable")}</p>
      ) : null}
      {!viewingFixture && overMemoryLimit && parts.length > 0 ? (
        <p className="text-sm text-foreground">
          {fillTemplate(t("concat.overLimit"), {
            total: formatByteCount(totalBytes, language),
            limit: limitLabel,
          })}
        </p>
      ) : null}

      {!viewingFixture && differences.length > 0 ? (
        <section className="border border-border px-4 py-4" aria-labelledby="concat-mismatch-heading">
          <h2 id="concat-mismatch-heading" className="text-sm font-medium text-foreground">
            {t("concat.mismatch.title")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("concat.mismatch.body")}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-foreground">
            {differences.map((difference) => (
              <li key={difference}>{t(differenceKey(difference))}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm leading-6 text-foreground">{t("concat.convert.warning")}</p>
          {capacity.mode === "memory" && overMemoryLimit ? (
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("concat.convert.overLimit")}</p>
          ) : (
            <button type="button" className={`${primaryButtonClassName} mt-4`} disabled={!canConvert} onClick={() => void runJoin("convert")}>
              {t("concat.convert.confirm")}
            </button>
          )}
        </section>
      ) : null}

      {differences.length === 0 ? (
        <button type="button" className={primaryButtonClassName} disabled={!canDirectJoin} onClick={() => void runJoin("copy")}>
          {running ? t("concat.joining") : t("concat.join")}
        </button>
      ) : null}

      {phase.kind === "running" || joinSucceeded ? (
        <div className="space-y-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={joinSucceeded ? joinedLabel : fillTemplate(t("concat.progress.label"), { percent })}
            className={joinSucceeded ? "progress progress-success" : "progress"}
          >
            <div className="progress-bar" style={{ width: `${percent}%` }} />
          </div>
          {phase.kind === "running" ? (
            <div className="flex flex-wrap items-center gap-4">
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                {fillTemplate(t("concat.progress.label"), { percent })}
              </p>
              <button
                type="button"
                className={secondaryButtonClassName}
                onClick={() => abortRef.current?.abort()}
              >
                {t("concat.cancel")}
              </button>
            </div>
          ) : (
            <p className="text-xs tabular-nums text-foreground">{joinedLabel}</p>
          )}
        </div>
      ) : null}

      {phase.kind === "saved" ? (
        <p className={resultMessageClassName}>{fillTemplate(t("concat.saved"), { name: phase.name })}</p>
      ) : null}
      {phase.kind === "download" ? (
        <div className="space-y-3">
          <p className={resultMessageClassName}>{fillTemplate(t("concat.downloaded"), { name: phase.name })}</p>
          <a href={phase.url} download={phase.name} className={secondaryButtonClassName}>
            {t("concat.download")}
          </a>
        </div>
      ) : null}
      {phase.kind === "failed" ? (
        <p className="text-sm text-foreground" role="alert">
          {t("concat.error.failed")}
        </p>
      ) : null}

      {successToast
        ? createPortal(
            <div className="toast">
              <p
                className="min-w-0 flex-1 [overflow-wrap:anywhere]"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {fillTemplate(t(successToast.destination === "saved" ? "concat.saved" : "concat.downloaded"), {
                  name: successToast.name,
                })}
              </p>
              <button type="button" className="toast-dismiss" onClick={() => setSuccessToast(null)}>
                {t("concat.toast.dismiss")}
              </button>
            </div>,
            document.body,
          )
        : null}

      {import.meta.env.DEV ? <ConcatListDataToggle mode={listDataMode} onChange={setListDataMode} /> : null}
    </div>
  );
};

export default ConcatTool;
