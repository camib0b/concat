import type { ConcatCapacity } from "@/lib/concat/types";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

/**
 * In-memory concat holds every part plus the output in the tab.
 * These ceilings sit under the point where each browser tends to kill the tab.
 */
const IOS_MEMORY_LIMIT_BYTES = 400 * MEBIBYTE;
const SAFARI_MEMORY_LIMIT_BYTES = GIBIBYTE;
const FIREFOX_MEMORY_LIMIT_BYTES = Math.floor(1.5 * GIBIBYTE);
const OTHER_MEMORY_LIMIT_BYTES = GIBIBYTE;

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

export function detectConcatCapacity(): ConcatCapacity {
  if (typeof window === "undefined") {
    return { mode: "memory", limitBytes: OTHER_MEMORY_LIMIT_BYTES, browserName: "other" };
  }

  const savePickerWindow = window as SavePickerWindow;
  if (typeof savePickerWindow.showSaveFilePicker === "function") {
    return { mode: "streaming", limitBytes: null };
  }

  const userAgent = navigator.userAgent;
  const isIos =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIos) {
    return { mode: "memory", limitBytes: IOS_MEMORY_LIMIT_BYTES, browserName: "ios" };
  }

  const isSafari = /Safari/i.test(userAgent) && !/Chrome|Chromium|Edg|OPR|Firefox/i.test(userAgent);
  if (isSafari) {
    return { mode: "memory", limitBytes: SAFARI_MEMORY_LIMIT_BYTES, browserName: "safari" };
  }

  if (/Firefox/i.test(userAgent)) {
    return { mode: "memory", limitBytes: FIREFOX_MEMORY_LIMIT_BYTES, browserName: "firefox" };
  }

  return { mode: "memory", limitBytes: OTHER_MEMORY_LIMIT_BYTES, browserName: "other" };
}

export type PickedJoinedFile = {
  writable: FileSystemWritableFileStream;
  name: string;
};

export async function pickJoinedFile(): Promise<PickedJoinedFile | null> {
  const savePickerWindow = window as SavePickerWindow;
  if (typeof savePickerWindow.showSaveFilePicker !== "function") {
    return null;
  }
  const handle = await savePickerWindow.showSaveFilePicker({
    suggestedName: "joined.mp4",
    types: [{ description: "MP4", accept: { "video/mp4": [".mp4"] } }],
  });
  return {
    writable: await handle.createWritable(),
    name: handle.name,
  };
}
