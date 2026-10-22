import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoCodec,
} from "mediabunny";
import { roundFrameRate } from "@/lib/concat/format";
import type { AudioSignature, ProbedPart, VideoSignature } from "@/lib/concat/types";

const VIDEO_CODECS = new Set<VideoCodec>(["avc", "hevc", "vp9", "av1", "vp8", "prores"]);
const AUDIO_CODECS = new Set<AudioCodec>([
  "aac",
  "opus",
  "mp3",
  "vorbis",
  "flac",
  "ac3",
  "eac3",
  "dts",
  "pcm-s16",
  "pcm-s16be",
  "pcm-s24",
  "pcm-s24be",
  "pcm-s32",
  "pcm-s32be",
  "pcm-f32",
  "pcm-f32be",
  "pcm-f64",
  "pcm-f64be",
  "pcm-u8",
  "pcm-s8",
  "ulaw",
  "alaw",
]);

function descriptionKey(description: AllowSharedBufferSource | undefined): string {
  if (description === undefined) {
    return "";
  }
  const bytes =
    description instanceof Uint8Array
      ? description
      : new Uint8Array(description instanceof ArrayBuffer ? description : description.buffer);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function openInput(file: Blob): Input {
  return new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
}

async function readVideoSignature(track: InputVideoTrack): Promise<VideoSignature | null> {
  const codec = await track.getCodec();
  if (codec === null || !VIDEO_CODECS.has(codec)) {
    return null;
  }
  const [codecParameter, decoderConfig, displayWidth, displayHeight, rotation, flip, timebaseHertz, frameRateMetrics] =
    await Promise.all([
      track.getCodecParameterString(),
      track.getDecoderConfig(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getRotation(),
      track.getFlip(),
      track.getTimeResolution(),
      track.computeFrameRateMetrics(),
    ]);
  const sink = new EncodedPacketSink(track);
  const firstPacket = await sink.getFirstPacket();
  return {
    codec,
    codecParameter: codecParameter ?? codec,
    descriptionKey: descriptionKey(decoderConfig?.description),
    displayWidth,
    displayHeight,
    rotation,
    flip,
    frameRate: roundFrameRate(frameRateMetrics.bestGuessFrameRate),
    timebaseHertz,
    startsWithKeyFrame: firstPacket?.type === "key",
  };
}

async function readAudioSignature(track: InputAudioTrack): Promise<AudioSignature | null> {
  const codec = await track.getCodec();
  if (codec === null || !AUDIO_CODECS.has(codec)) {
    return null;
  }
  const [codecParameter, decoderConfig, sampleRate, channels, timebaseHertz] = await Promise.all([
    track.getCodecParameterString(),
    track.getDecoderConfig(),
    track.getSampleRate(),
    track.getNumberOfChannels(),
    track.getTimeResolution(),
  ]);
  return {
    codec,
    codecParameter: codecParameter ?? codec,
    descriptionKey: descriptionKey(decoderConfig?.description),
    sampleRate,
    channels,
    timebaseHertz,
  };
}

/** Reads container metadata. Does not load the media samples or any WebAssembly. */
export async function probeVideoFile(file: Blob): Promise<ProbedPart> {
  const input = openInput(file);
  try {
    if (!(await input.canRead())) {
      return { durationSeconds: null, video: null, audio: null, readable: false };
    }
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      return { durationSeconds: null, video: null, audio: null, readable: false };
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    const [video, audio, durationFromMetadata] = await Promise.all([
      readVideoSignature(videoTrack),
      audioTrack ? readAudioSignature(audioTrack) : Promise.resolve(null),
      input.getDurationFromMetadata(),
    ]);
    if (!video) {
      return { durationSeconds: null, video: null, audio: null, readable: false };
    }
    const durationSeconds =
      durationFromMetadata !== null && Number.isFinite(durationFromMetadata)
        ? durationFromMetadata
        : await input.computeDuration();
    return {
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      video,
      audio,
      readable: true,
    };
  } catch (error) {
    console.error("concat probe failed", error);
    return { durationSeconds: null, video: null, audio: null, readable: false };
  } finally {
    input.dispose();
  }
}
