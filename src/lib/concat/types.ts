export class ConcatCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "ConcatCancelledError";
  }
}

export function isConcatCancelled(error: unknown): boolean {
  if (error instanceof ConcatCancelledError) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && (error.name === "AbortError" || error.name === "ConversionCanceledError");
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ConcatCancelledError();
  }
}

/** Properties compared before a stream-copy join. Times are ticks per second. */
export type VideoSignature = {
  codec: string;
  codecParameter: string;
  descriptionKey: string;
  displayWidth: number;
  displayHeight: number;
  rotation: 0 | 90 | 180 | 270;
  flip: boolean;
  frameRate: number;
  timebaseHertz: number;
  startsWithKeyFrame: boolean;
};

export type AudioSignature = {
  codec: string;
  codecParameter: string;
  descriptionKey: string;
  sampleRate: number;
  channels: number;
  timebaseHertz: number;
};

export type ProbedPart = {
  durationSeconds: number | null;
  video: VideoSignature | null;
  audio: AudioSignature | null;
  readable: boolean;
};

export type PartDifference = "codec" | "resolution" | "frameRate" | "timebase" | "audio" | "keyframe";

export type ConvertTarget = {
  width: number;
  height: number;
  frameRate: number;
  audio: {
    sampleRate: number;
    channels: number;
  } | null;
};

export type ConcatCapacity =
  | { mode: "streaming"; limitBytes: null }
  | { mode: "memory"; limitBytes: number; browserName: "ios" | "safari" | "firefox" | "other" };

/** Values the part list renders. Real files and the dev fixtures share this shape. */
export type ConcatPartView = {
  id: string;
  name: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  state: "reading" | "ready" | "unreadable";
};
