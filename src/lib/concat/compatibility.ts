import { evenDimension } from "@/lib/concat/format";
import type {
  AudioSignature,
  ConvertTarget,
  PartDifference,
  ProbedPart,
  VideoSignature,
} from "@/lib/concat/types";

const DIFFERENCE_ORDER: readonly PartDifference[] = [
  "codec",
  "resolution",
  "frameRate",
  "timebase",
  "audio",
  "keyframe",
];

/** Codecs an MP4 stream-copy can carry without re-encoding. */
const MP4_VIDEO_CODECS = new Set(["avc", "hevc", "vp9", "av1", "vp8"]);
const MP4_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "flac", "ac3", "eac3"]);

function videoCanStreamCopy(video: VideoSignature): boolean {
  return MP4_VIDEO_CODECS.has(video.codec);
}

function audioCanStreamCopy(audio: AudioSignature): boolean {
  return MP4_AUDIO_CODECS.has(audio.codec);
}

function videosMatch(reference: VideoSignature, candidate: VideoSignature): PartDifference[] {
  const differences: PartDifference[] = [];
  const sameCodec =
    reference.codec === candidate.codec &&
    reference.codecParameter === candidate.codecParameter &&
    reference.descriptionKey === candidate.descriptionKey &&
    videoCanStreamCopy(reference) &&
    videoCanStreamCopy(candidate);
  if (!sameCodec) {
    differences.push("codec");
  }
  const samePicture =
    reference.displayWidth === candidate.displayWidth &&
    reference.displayHeight === candidate.displayHeight &&
    reference.rotation === candidate.rotation &&
    reference.flip === candidate.flip;
  if (!samePicture) {
    differences.push("resolution");
  }
  if (reference.frameRate !== candidate.frameRate) {
    differences.push("frameRate");
  }
  if (reference.timebaseHertz !== candidate.timebaseHertz) {
    differences.push("timebase");
  }
  return differences;
}

function audiosMatch(reference: AudioSignature | null, candidate: AudioSignature | null): PartDifference[] {
  if (reference === null || candidate === null) {
    return reference === candidate ? [] : ["audio"];
  }
  const differences: PartDifference[] = [];
  const sameAudio =
    reference.codec === candidate.codec &&
    reference.codecParameter === candidate.codecParameter &&
    reference.descriptionKey === candidate.descriptionKey &&
    reference.sampleRate === candidate.sampleRate &&
    reference.channels === candidate.channels &&
    audioCanStreamCopy(reference) &&
    audioCanStreamCopy(candidate);
  if (!sameAudio) {
    differences.push("audio");
  }
  if (reference.timebaseHertz !== candidate.timebaseHertz) {
    differences.push("timebase");
  }
  return differences;
}

/** Empty when every part can be stream-copied onto the first part. */
export function compareParts(parts: readonly ProbedPart[]): PartDifference[] {
  const reference = parts[0];
  if (!reference?.video || parts.length < 2) {
    return [];
  }
  const found = new Set<PartDifference>();
  if (!videoCanStreamCopy(reference.video)) {
    found.add("codec");
  }
  if (reference.audio !== null && !audioCanStreamCopy(reference.audio)) {
    found.add("audio");
  }
  for (let index = 1; index < parts.length; index += 1) {
    const candidate = parts[index];
    if (!candidate?.video) {
      found.add("codec");
      continue;
    }
    for (const difference of videosMatch(reference.video, candidate.video)) {
      found.add(difference);
    }
    for (const difference of audiosMatch(reference.audio, candidate.audio)) {
      found.add(difference);
    }
    if (!candidate.video.startsWithKeyFrame) {
      found.add("keyframe");
    }
  }
  return DIFFERENCE_ORDER.filter((difference) => found.has(difference));
}

export function convertTargetFor(parts: readonly ProbedPart[]): ConvertTarget | null {
  const firstVideo = parts.find((part) => part.video)?.video;
  if (!firstVideo || firstVideo.displayWidth <= 0 || firstVideo.displayHeight <= 0) {
    return null;
  }
  const firstAudio = parts.find((part) => part.audio)?.audio ?? null;
  return {
    width: evenDimension(firstVideo.displayWidth),
    height: evenDimension(firstVideo.displayHeight),
    frameRate: firstVideo.frameRate > 0 ? firstVideo.frameRate : 30,
    audio: firstAudio
      ? {
          sampleRate: firstAudio.sampleRate > 0 ? firstAudio.sampleRate : 48000,
          channels: firstAudio.channels <= 1 ? 1 : 2,
        }
      : null,
  };
}
