import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  EncodedPacket,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import { ConcatCancelledError, throwIfCancelled } from "@/lib/concat/types";

const OUTPUT_CHUNK_BYTES = 8 * 1024 * 1024;

type PacketIterator = AsyncGenerator<EncodedPacket, void, unknown>;

async function take(iterator: PacketIterator | null): Promise<EncodedPacket | null> {
  if (!iterator) {
    return null;
  }
  const next = await iterator.next();
  if (next.done || !(next.value instanceof EncodedPacket)) {
    return null;
  }
  return next.value;
}

function shiftedPacket(packet: EncodedPacket, zeroTimestamp: number, offsetSeconds: number, sequenceNumber: number): EncodedPacket {
  return packet.clone({
    timestamp: packet.timestamp - zeroTimestamp + offsetSeconds,
    sequenceNumber,
  });
}

async function partDuration(input: Input): Promise<number> {
  const fromMetadata = await input.getDurationFromMetadata();
  if (fromMetadata !== null && Number.isFinite(fromMetadata) && fromMetadata >= 0) {
    return fromMetadata;
  }
  return input.computeDuration();
}

/**
 * Stream-copy join. Samples are read in ranges and written in chunks to the
 * file the user picked. The output is not held in memory, so a multi-GB match
 * can finish. Mediabunny's stream target is the maintained writer for the File
 * System Access API; mp4box keeps the finished file in memory.
 */
export async function streamCopyFiles(options: {
  files: readonly Blob[];
  writable: FileSystemWritableFileStream;
  signal: AbortSignal;
  onProgress: (ratio: number) => void;
  /** Final file size, including a partial write when the join fails. */
  outputBytes: { bytes: number };
}): Promise<void> {
  throwIfCancelled(options.signal);
  let writtenBytes = 0;
  let fileWriter: WritableStreamDefaultWriter<FileSystemWriteChunkType> | null = null;
  const countingStream = new WritableStream<StreamTargetChunk>({
    start() {
      fileWriter = options.writable.getWriter();
    },
    async write(chunk) {
      const writer = fileWriter;
      if (!writer) {
        throw new Error("concat-missing-save");
      }
      const position = Number.isFinite(chunk.position) ? chunk.position : 0;
      const chunkEnd = position + chunk.data.byteLength;
      await writer.write(chunk);
      if (chunkEnd > writtenBytes) {
        writtenBytes = chunkEnd;
      }
    },
    async close() {
      await fileWriter?.close();
    },
    async abort(reason) {
      if (fileWriter) {
        await fileWriter.abort(reason);
        return;
      }
      await options.writable.abort(reason);
    },
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(countingStream, {
      chunked: true,
      chunkSize: OUTPUT_CHUNK_BYTES,
    }),
  });

  let videoSource: EncodedVideoPacketSource | null = null;
  let audioSource: EncodedAudioPacketSource | null = null;
  let videoMetaSent = false;
  let audioMetaSent = false;
  let sequenceNumber = 0;
  let runningOffset = 0;
  const durations: number[] = [];

  const inputs: Input[] = [];
  try {
    for (const file of options.files) {
      throwIfCancelled(options.signal);
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
      inputs.push(input);
      durations.push(await partDuration(input));
    }
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);

    for (let index = 0; index < options.files.length; index += 1) {
      throwIfCancelled(options.signal);
      const input = inputs[index];
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw new Error("concat-missing-video");
      }
      const audioTrack = await input.getPrimaryAudioTrack();
      const zeroTimestamp = await input.getFirstTimestamp();
      const videoCodec = await videoTrack.getCodec();
      const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
      if (!videoCodec) {
        throw new Error("concat-missing-codec");
      }
      if (!videoSource) {
        videoSource = new EncodedVideoPacketSource(videoCodec);
        const rotation = await videoTrack.getRotation();
        const flip = await videoTrack.getFlip();
        output.addVideoTrack(videoSource, { rotation, flip });
      }
      if (audioTrack && audioCodec && !audioSource) {
        audioSource = new EncodedAudioPacketSource(audioCodec);
        output.addAudioTrack(audioSource);
      }
      if (index === 0) {
        await output.start();
      }

      const videoDecoderConfig = videoMetaSent ? null : await videoTrack.getDecoderConfig();
      const audioDecoderConfig = audioTrack && !audioMetaSent ? await audioTrack.getDecoderConfig() : null;
      const videoIterator = new EncodedPacketSink(videoTrack).packets();
      const audioIterator = audioTrack && audioSource ? new EncodedPacketSink(audioTrack).packets() : null;
      let videoPacket = await take(videoIterator);
      let audioPacket = await take(audioIterator);
      let packetsWritten = 0;

      while (videoPacket || audioPacket) {
        throwIfCancelled(options.signal);
        const videoStamp = videoPacket ? videoPacket.timestamp : Number.POSITIVE_INFINITY;
        const audioStamp = audioPacket ? audioPacket.timestamp : Number.POSITIVE_INFINITY;
        if (videoPacket && videoStamp <= audioStamp) {
          const packet = shiftedPacket(videoPacket, zeroTimestamp, runningOffset, sequenceNumber);
          sequenceNumber += 1;
          if (!videoMetaSent) {
            if (!videoDecoderConfig) {
              throw new Error("concat-missing-decoder-config");
            }
            await videoSource.add(packet, { decoderConfig: videoDecoderConfig });
            videoMetaSent = true;
          } else {
            await videoSource.add(packet);
          }
          videoPacket = await take(videoIterator);
        } else if (audioPacket && audioSource) {
          const packet = shiftedPacket(audioPacket, zeroTimestamp, runningOffset, sequenceNumber);
          sequenceNumber += 1;
          if (!audioMetaSent) {
            if (!audioDecoderConfig) {
              throw new Error("concat-missing-audio-config");
            }
            await audioSource.add(packet, { decoderConfig: audioDecoderConfig });
            audioMetaSent = true;
          } else {
            await audioSource.add(packet);
          }
          audioPacket = await take(audioIterator);
        } else {
          break;
        }
        packetsWritten += 1;
        if (packetsWritten % 30 === 0 && totalDuration > 0) {
          const cursor = videoPacket?.timestamp ?? audioPacket?.timestamp ?? durations[index];
          const local = Math.max(0, cursor - zeroTimestamp);
          options.onProgress(Math.min(1, (runningOffset + local) / totalDuration));
        }
      }

      runningOffset += durations[index] ?? 0;
      if (totalDuration > 0) {
        options.onProgress(Math.min(1, runningOffset / totalDuration));
      }
    }

    videoSource?.close();
    audioSource?.close();
    await output.finalize();
    options.onProgress(1);
  } catch (error) {
    try {
      await output.cancel();
    } catch {
      // The output may already be finalized or cancelled.
    }
    if (options.signal.aborted) {
      throw new ConcatCancelledError();
    }
    throw error;
  } finally {
    options.outputBytes.bytes = writtenBytes;
    for (const input of inputs) {
      input.dispose();
    }
  }
}
