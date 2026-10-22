import type { ConvertTarget } from "@/lib/concat/types";
import { throwIfCancelled } from "@/lib/concat/types";

/**
 * Loads the join implementation for this action. WebAssembly is imported only
 * from the in-memory branch, after the coach has started a join.
 */
export async function joinParts(options: {
  files: readonly Blob[];
  mode: "copy" | "convert";
  streaming: boolean;
  writable: FileSystemWritableFileStream | null;
  hasAudio: readonly boolean[];
  target: ConvertTarget | null;
  signal: AbortSignal;
  onProgress: (ratio: number) => void;
  outputBytes: { bytes: number };
}): Promise<Blob | null> {
  throwIfCancelled(options.signal);
  if (options.mode === "copy" && options.streaming) {
    if (!options.writable) {
      throw new Error("concat-missing-save");
    }
    const { streamCopyFiles } = await import("@/lib/concat/streamCopy");
    await streamCopyFiles({
      files: options.files,
      writable: options.writable,
      signal: options.signal,
      onProgress: options.onProgress,
      outputBytes: options.outputBytes,
    });
    return null;
  }
  if (options.mode === "copy") {
    const { memoryCopyConcat } = await import("@/lib/concat/memoryConcat");
    const joined = await memoryCopyConcat({
      files: options.files,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    options.outputBytes.bytes = joined.size;
    return joined;
  }
  if (!options.target) {
    throw new Error("concat-missing-target");
  }
  if (options.streaming) {
    if (!options.writable) {
      throw new Error("concat-missing-save");
    }
    const { convertAndStream } = await import("@/lib/concat/convertStream");
    await convertAndStream({
      files: options.files,
      writable: options.writable,
      target: options.target,
      signal: options.signal,
      onProgress: options.onProgress,
      outputBytes: options.outputBytes,
    });
    return null;
  }
  const { memoryConvertConcat } = await import("@/lib/concat/memoryConcat");
  const joined = await memoryConvertConcat({
    files: options.files,
    hasAudio: options.hasAudio,
    target: options.target,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  options.outputBytes.bytes = joined.size;
  return joined;
}
