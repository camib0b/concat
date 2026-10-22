import type { ConcatPartView } from "@/lib/concat/types";

export const CONCAT_LIST_DATA_MODES = ["live", "demo", "worst", "empty", "one", "many"] as const;

export type ConcatListDataMode = (typeof CONCAT_LIST_DATA_MODES)[number];

export function isConcatListDataMode(value: string | null): value is ConcatListDataMode {
  return CONCAT_LIST_DATA_MODES.some((mode) => mode === value);
}

const DEMO_PARTS: readonly ConcatPartView[] = [
  {
    id: "demo-quarter-1",
    name: "GH010123.MP4",
    sizeBytes: 1_834_291_200,
    durationSeconds: 12 * 60 + 4,
    state: "ready",
  },
  {
    id: "demo-quarter-2",
    name: "GH020123.MP4",
    sizeBytes: 1_610_612_736,
    durationSeconds: 11 * 60 + 2,
    state: "ready",
  },
  {
    id: "demo-phone",
    name: "IMG_3481.MOV",
    sizeBytes: 842_530_816,
    durationSeconds: 8 * 60 + 11,
    state: "ready",
  },
];

/** One dataset. Each row hits a different realistic failure, the way a real import does. */
const WORST_CASE_PARTS: readonly ConcatPartView[] = [
  {
    id: "worst-long-name",
    name: "Q3 Board Deck — FINAL (revised) v12 [approved by legal].mp4",
    sizeBytes: 12_345_678_901,
    durationSeconds: 1284 * 60 * 60,
    state: "ready",
  },
  {
    id: "worst-camera-name",
    name: "IMG_20250914_183022_HDR_portrait_edited_edited.HEIC",
    sizeBytes: 1,
    durationSeconds: 1,
    state: "ready",
  },
  {
    id: "worst-one-letter",
    name: "J.mp4",
    sizeBytes: 0,
    durationSeconds: 0,
    state: "ready",
  },
  {
    id: "worst-vietnamese",
    name: "Đặng Thị Ngọc Hân — cuarto.mp4",
    sizeBytes: 1284,
    durationSeconds: null,
    state: "ready",
  },
  {
    id: "worst-rtl",
    name: "نور الهدى عبد الرحمن.mp4",
    sizeBytes: 1_000_000,
    durationSeconds: 90,
    state: "ready",
  },
  {
    id: "worst-emoji",
    name: "🦊 Fox.mov",
    sizeBytes: 42,
    durationSeconds: 3.2,
    state: "ready",
  },
  {
    id: "worst-markup",
    name: "<script>alert(1)</script>.mp4",
    sizeBytes: 999,
    durationSeconds: 12,
    state: "ready",
  },
  {
    id: "worst-newline",
    name: "Line one\nLine two.mp4",
    sizeBytes: 2048,
    durationSeconds: 8,
    state: "ready",
  },
  {
    id: "worst-duplicate-a",
    name: "GH010123.MP4",
    sizeBytes: 1_800_000_000,
    durationSeconds: 720,
    state: "ready",
  },
  {
    id: "worst-duplicate-b",
    name: "GH010123.MP4",
    sizeBytes: 1_800_000_001,
    durationSeconds: 721,
    state: "ready",
  },
  {
    id: "worst-blank",
    name: "   ",
    sizeBytes: 4096,
    durationSeconds: 2,
    state: "ready",
  },
  {
    id: "worst-unreadable",
    name: "Aleksandra Wiśniewska-Kowalczyk match backup.mts",
    sizeBytes: 86_000_000,
    durationSeconds: null,
    state: "unreadable",
  },
];

const ONE_PART: readonly ConcatPartView[] = [
  {
    id: "one-part",
    name: "GH010123.MP4",
    sizeBytes: 1_834_291_200,
    durationSeconds: 12 * 60 + 4,
    state: "ready",
  },
];

function createManyParts(): ConcatPartView[] {
  return Array.from({ length: 1000 }, (_, index) => ({
    id: `many-${index}`,
    name: `GH${String(index + 1).padStart(6, "0")}.MP4`,
    sizeBytes: 1_800_000_000 + index * 1024,
    durationSeconds: 12 * 60 + (index % 17),
    state: "ready" as const,
  }));
}

export function partsForConcatListDataMode(mode: ConcatListDataMode): ConcatPartView[] {
  switch (mode) {
    case "demo":
      return DEMO_PARTS.map((part) => ({ ...part }));
    case "worst":
      return WORST_CASE_PARTS.map((part) => ({ ...part }));
    case "empty":
      return [];
    case "one":
      return ONE_PART.map((part) => ({ ...part }));
    case "many":
      return createManyParts();
    case "live":
      return [];
  }
}
