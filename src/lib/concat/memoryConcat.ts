import type { FFmpeg } from "@ffmpeg/ffmpeg";
const coreJavaScriptUrl = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js";
const coreWasmUrl = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm";
import { ConcatCancelledError, throwIfCancelled, type ConvertTarget } from "@/lib/concat/types";

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

function resetFfmpeg(): void {
  ffmpegInstance?.terminate();
  ffmpegInstance = null;
  loadPromise = null;
}

async function loadFfmpeg(signal: AbortSignal): Promise<FFmpeg> {
  throwIfCancelled(signal);
  if (!ffmpegInstance) {
    if (!loadPromise) {
      loadPromise = (async () => {
        const { FFmpeg } = await import("@ffmpeg/ffmpeg");
        const { toBlobURL } = await import("@ffmpeg/util");
        const ffmpeg = new FFmpeg();
        await ffmpeg.load({
          coreURL: await toBlobURL(coreJavaScriptUrl, "text/javascript"),
          wasmURL: await toBlobURL(coreWasmUrl, "application/wasm"),
        });
        return ffmpeg;
      })().catch((error: unknown) => {
        loadPromise = null;
        throw error;
      });
    }
    ffmpegInstance = await loadPromise;
  }
  throwIfCancelled(signal);
  return ffmpegInstance;
}

function extensionOf(file: Blob, index: number): string {
  const name = file instanceof File ? file.name : "";
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  const extension = match?.[1]?.toLowerCase() ?? "mp4";
  return `source-${String(index).padStart(3, "0")}.${extension}`;
}

async function writeInput(ffmpeg: FFmpeg, file: Blob, name: string, signal: AbortSignal): Promise<void> {
  const { fetchFile } = await import("@ffmpeg/util");
  await ffmpeg.writeFile(name, await fetchFile(file), { signal });
}

async function readOutput(ffmpeg: FFmpeg, signal: AbortSignal): Promise<Blob> {
  const data = await ffmpeg.readFile("output.mp4", undefined, { signal });
  if (typeof data === "string") {
    throw new Error("concat-output-was-text");
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Blob([copy], { type: "video/mp4" });
}

async function deleteQuietly(ffmpeg: FFmpeg, name: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    // The file may already be gone after a failed exec.
  }
}

function fpsArgument(frameRate: number): string {
  const rounded = Math.round(frameRate * 1000) / 1000;
  if (Math.abs(rounded - 23.976) < 0.002) return "24000/1001";
  if (Math.abs(rounded - 29.97) < 0.002) return "30000/1001";
  if (Math.abs(rounded - 59.94) < 0.002) return "60000/1001";
  return String(rounded);
}

/**
 * In-memory join for browsers without the File System Access API.
 * Uses the concat demuxer and stream copy (`-c copy`). The wasm module is
 * loaded here, on the join action, not when the page opens.
 */
export async function memoryCopyConcat(options: {
  files: readonly Blob[];
  signal: AbortSignal;
  onProgress: (ratio: number) => void;
}): Promise<Blob> {
  const ffmpeg = await loadFfmpeg(options.signal);
  const copyProgress = ({ progress }: { progress: number }) => {
    if (Number.isFinite(progress)) {
      options.onProgress(Math.max(0, Math.min(1, progress)));
    }
  };
  ffmpeg.on("progress", copyProgress);
  const names = options.files.map((file, index) => extensionOf(file, index));
  const onAbort = () => {
    resetFfmpeg();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (let index = 0; index < options.files.length; index += 1) {
      throwIfCancelled(options.signal);
      await writeInput(ffmpeg, options.files[index], names[index], options.signal);
    }
    const list = names.map((name) => `file '${name}'`).join("\n");
    await ffmpeg.writeFile("list.txt", list, { signal: options.signal });
    const exitCode = await ffmpeg.exec(
      ["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "output.mp4"],
      undefined,
      { signal: options.signal },
    );
    if (exitCode !== 0) {
      throw new Error("concat-ffmpeg-copy-failed");
    }
    const result = await readOutput(ffmpeg, options.signal);
    for (const name of names) {
      await deleteQuietly(ffmpeg, name);
    }
    await deleteQuietly(ffmpeg, "list.txt");
    await deleteQuietly(ffmpeg, "output.mp4");
    options.onProgress(1);
    return result;
  } catch (error) {
    if (options.signal.aborted) {
      throw new ConcatCancelledError();
    }
    throw error;
  } finally {
    ffmpeg.off("progress", copyProgress);
    options.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * In-memory re-encode, used only after the coach confirms. Much slower than
 * stream copy. Each part is normalized, then the concat demuxer copies them.
 */
export async function memoryConvertConcat(options: {
  files: readonly Blob[];
  hasAudio: readonly boolean[];
  target: ConvertTarget;
  signal: AbortSignal;
  onProgress: (ratio: number) => void;
}): Promise<Blob> {
  const ffmpeg = await loadFfmpeg(options.signal);
  const onAbort = () => {
    resetFfmpeg();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  const sourceNames = options.files.map((file, index) => extensionOf(file, index));
  const normalizedNames = sourceNames.map((_, index) => `normalized-${String(index).padStart(3, "0")}.mp4`);
  const steps = options.files.length + 1;
  try {
    const filter = [
      `scale=${options.target.width}:${options.target.height}:force_original_aspect_ratio=decrease`,
      `pad=${options.target.width}:${options.target.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `fps=${fpsArgument(options.target.frameRate)}`,
    ].join(",");
    for (let index = 0; index < options.files.length; index += 1) {
      throwIfCancelled(options.signal);
      await writeInput(ffmpeg, options.files[index], sourceNames[index], options.signal);
      const progressHandler = ({ progress }: { progress: number }) => {
        if (!Number.isFinite(progress)) return;
        options.onProgress(Math.min(1, (index + Math.max(0, Math.min(1, progress))) / steps));
      };
      ffmpeg.on("progress", progressHandler);
      const args = convertArguments({
        inputName: sourceNames[index],
        outputName: normalizedNames[index],
        filter,
        hasAudio: options.hasAudio[index] === true,
        target: options.target,
      });
      const exitCode = await ffmpeg.exec(args, undefined, { signal: options.signal });
      ffmpeg.off("progress", progressHandler);
      if (exitCode !== 0) {
        throw new Error("concat-ffmpeg-convert-failed");
      }
      await deleteQuietly(ffmpeg, sourceNames[index]);
    }
    const list = normalizedNames.map((name) => `file '${name}'`).join("\n");
    await ffmpeg.writeFile("list.txt", list, { signal: options.signal });
    const concatProgress = ({ progress }: { progress: number }) => {
      if (!Number.isFinite(progress)) return;
      options.onProgress(Math.min(1, (options.files.length + Math.max(0, Math.min(1, progress))) / steps));
    };
    ffmpeg.on("progress", concatProgress);
    const concatExit = await ffmpeg.exec(
      ["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "output.mp4"],
      undefined,
      { signal: options.signal },
    );
    ffmpeg.off("progress", concatProgress);
    if (concatExit !== 0) {
      throw new Error("concat-ffmpeg-copy-failed");
    }
    const result = await readOutput(ffmpeg, options.signal);
    for (const name of normalizedNames) {
      await deleteQuietly(ffmpeg, name);
    }
    await deleteQuietly(ffmpeg, "list.txt");
    await deleteQuietly(ffmpeg, "output.mp4");
    options.onProgress(1);
    return result;
  } catch (error) {
    if (options.signal.aborted) {
      throw new ConcatCancelledError();
    }
    throw error;
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

function convertArguments(options: {
  inputName: string;
  outputName: string;
  filter: string;
  hasAudio: boolean;
  target: ConvertTarget;
}): string[] {
  const videoArguments = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
  if (!options.target.audio) {
    return [
      "-i",
      options.inputName,
      "-vf",
      options.filter,
      "-map",
      "0:v:0",
      "-an",
      ...videoArguments,
      options.outputName,
    ];
  }
  const audioArguments = [
    "-c:a",
    "aac",
    "-ar",
    String(options.target.audio.sampleRate),
    "-ac",
    String(options.target.audio.channels),
    "-b:a",
    "160k",
  ];
  if (options.hasAudio) {
    return [
      "-i",
      options.inputName,
      "-vf",
      options.filter,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      ...videoArguments,
      ...audioArguments,
      options.outputName,
    ];
  }
  const layout = options.target.audio.channels <= 1 ? "mono" : "stereo";
  return [
    "-i",
    options.inputName,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=${layout}:sample_rate=${options.target.audio.sampleRate}`,
    "-vf",
    options.filter,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest",
    ...videoArguments,
    ...audioArguments,
    options.outputName,
  ];
}
