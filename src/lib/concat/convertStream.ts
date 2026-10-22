import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import { streamCopyFiles } from "@/lib/concat/streamCopy";
import { ConcatCancelledError, throwIfCancelled, type ConvertTarget } from "@/lib/concat/types";

const OUTPUT_CHUNK_BYTES = 8 * 1024 * 1024;

async function removeTemporary(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  } catch {
    // Already removed, or private storage is unavailable.
  }
}

async function convertOneFile(options: {
  file: Blob;
  target: ConvertTarget;
  signal: AbortSignal;
  onProgress: (ratio: number) => void;
}): Promise<File> {
  throwIfCancelled(options.signal);
  const root = await navigator.storage.getDirectory();
  const temporaryName = `concat-${crypto.randomUUID()}.mp4`;
  const handle = await root.getFileHandle(temporaryName, { create: true });
  const writable = await handle.createWritable();
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(options.file),
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, {
      chunked: true,
      chunkSize: OUTPUT_CHUNK_BYTES,
    }),
  });
  let conversion: Conversion | null = null;
  const onAbort = () => {
    void conversion?.cancel();
  };
  options.signal.addEventListener("abort", onAbort);
  try {
    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      showWarnings: false,
      video: {
        codec: "avc",
        width: options.target.width,
        height: options.target.height,
        fit: "contain",
        frameRate: options.target.frameRate,
        forceTranscode: true,
        allowTransformationMetadata: false,
        quality: new Quality("high"),
      },
      audio: options.target.audio
        ? {
            codec: "aac",
            sampleRate: options.target.audio.sampleRate,
            numberOfChannels: options.target.audio.channels,
            forceTranscode: true,
            quality: new Quality("high"),
          }
        : { discard: true },
    });
    if (!conversion.isValid) {
      throw new Error("concat-convert-unsupported");
    }
    conversion.onProgress = (ratio) => {
      if (Number.isFinite(ratio)) {
        options.onProgress(Math.max(0, Math.min(1, ratio)));
      }
    };
    await conversion.execute();
    return await handle.getFile();
  } catch (error) {
    try {
      await conversion?.cancel();
    } catch {
      // Cancellation is best-effort once execute has failed.
    }
    await removeTemporary(temporaryName);
    if (options.signal.aborted) {
      throw new ConcatCancelledError();
    }
    throw error;
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    input.dispose();
  }
}

/**
 * Re-encode each part to a private temporary file, then stream-copy those
 * matching files into the save location. Used after the coach confirms, and
 * only where the File System Access API can write the result in chunks.
 */
export async function convertAndStream(options: {
  files: readonly Blob[];
  writable: FileSystemWritableFileStream;
  target: ConvertTarget;
  signal: AbortSignal;
  onProgress: (ratio: number) => void;
  outputBytes: { bytes: number };
}): Promise<void> {
  const temporaryFiles: File[] = [];
  let handedOff = false;
  try {
    for (let index = 0; index < options.files.length; index += 1) {
      throwIfCancelled(options.signal);
      const file = await convertOneFile({
        file: options.files[index],
        target: options.target,
        signal: options.signal,
        onProgress: (ratio) => {
          options.onProgress(((index + ratio) / options.files.length) * 0.9);
        },
      });
      temporaryFiles.push(file);
    }
    handedOff = true;
    await streamCopyFiles({
      files: temporaryFiles,
      writable: options.writable,
      signal: options.signal,
      onProgress: (ratio) => {
        options.onProgress(0.9 + ratio * 0.1);
      },
      outputBytes: options.outputBytes,
    });
  } catch (error) {
    if (!handedOff) {
      try {
        await options.writable.abort();
      } catch {
        // The picker stream may already be closed.
      }
    }
    throw error;
  } finally {
    for (const file of temporaryFiles) {
      await removeTemporary(file.name);
    }
  }
}
