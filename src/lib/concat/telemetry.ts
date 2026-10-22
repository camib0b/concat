const CONCAT_EVENT_PATH = "/api/concat-event";

const BROWSER_FAMILIES = ["chrome", "edge", "firefox", "safari", "ios", "other"] as const;

export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

export type ConcatJoinPath = "stream" | "memory";

export type ConcatJoinOutcome = "success" | "error" | "cancelled";

/** Anonymous join count. No file names, footage, or identifiers. */
export type ConcatTelemetryEvent = {
  browser: BrowserFamily;
  path: ConcatJoinPath;
  matched: boolean;
  converted: boolean;
  partCount: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
  outcome: ConcatJoinOutcome;
  errorCode: string;
};

const KNOWN_ERROR_CODES: Record<string, string> = {
  "concat-missing-save": "missing-save",
  "concat-missing-target": "missing-target",
  "concat-missing-video": "missing-video",
  "concat-missing-codec": "missing-codec",
  "concat-missing-decoder-config": "missing-decoder",
  "concat-missing-audio-config": "missing-audio",
  "concat-convert-unsupported": "convert-unsupported",
  "concat-output-was-text": "output-text",
  "concat-ffmpeg-copy-failed": "copy-failed",
  "concat-ffmpeg-convert-failed": "convert-failed",
};

function finiteCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
}

/**
 * Coarse browser family for the join count. iOS is reported on its own because
 * every browser there is WebKit and joins in memory.
 */
export function detectBrowserFamily(): BrowserFamily {
  if (typeof navigator === "undefined") {
    return "other";
  }
  const userAgent = navigator.userAgent;
  const isIos =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIos) {
    return "ios";
  }
  if (/Edg\//i.test(userAgent)) {
    return "edge";
  }
  if (/Firefox/i.test(userAgent)) {
    return "firefox";
  }
  if (/OPR\/|Opera|SamsungBrowser/i.test(userAgent)) {
    return "other";
  }
  if (/Chrome|Chromium/i.test(userAgent)) {
    return "chrome";
  }
  if (/Safari/i.test(userAgent)) {
    return "safari";
  }
  return "other";
}

/** A short allowlisted code. Raw messages can contain file names, so they are never sent. */
export function concatErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "QuotaExceededError") {
    return "quota";
  }
  if (name === "NotAllowedError") {
    return "not-allowed";
  }
  if (name === "NotFoundError") {
    return "not-found";
  }
  if (name === "SecurityError") {
    return "security";
  }
  if (error instanceof Error) {
    const known = KNOWN_ERROR_CODES[error.message];
    if (known) {
      return known;
    }
  }
  return "failed";
}

/**
 * One small POST after a join attempt. sendBeacon survives a closing page;
 * fetch with keepalive covers browsers that refuse the beacon.
 */
export function reportConcatEvent(event: ConcatTelemetryEvent): void {
  let body = "";
  try {
    body = JSON.stringify({
      browser: event.browser,
      path: event.path,
      matched: event.matched,
      converted: event.converted,
      partCount: finiteCount(event.partCount),
      inputBytes: finiteCount(event.inputBytes),
      outputBytes: finiteCount(event.outputBytes),
      durationMs: finiteCount(event.durationMs),
      outcome: event.outcome,
      errorCode: event.outcome === "error" ? event.errorCode : "",
    });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(CONCAT_EVENT_PATH, blob)) {
        return;
      }
    }
  } catch {
    // Fall through to fetch. The join result must not depend on this POST.
  }
  if (body === "" || typeof fetch !== "function") {
    return;
  }
  void fetch(CONCAT_EVENT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "omit",
    cache: "no-store",
  }).catch(() => {
    // The count is optional. Ignore network failures.
  });
}
