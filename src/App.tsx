import {
  AudioLines,
  Check,
  Download,
  FileAudio,
  Loader2,
  Music2,
  RefreshCcw,
  Sparkles,
  X,
} from "lucide-react";
import { ChangeEvent, useMemo, useRef, useState } from "react";

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const OCTAVES = ["0", "1", "2", "3", "4", "5", "6", "7", "8"];
const SAMPLE_RATES = [48000, 44100];
const ORDER_MODES = ["sequential", "shuffle", "random"] as const;
const AUDIO_STYLES = ["Current", "OG App", "Praat"] as const;
const DEFAULT_SAMPLE_RATE = 48000;

type OrderMode = (typeof ORDER_MODES)[number];
type AudioStyle = (typeof AUDIO_STYLES)[number];

type Settings = {
  startNoteIndex: number;
  startOctave: number;
  semitones: number;
  gapSeconds: number;
  pitchSamples: boolean;
  dumpSamples: boolean;
  orderMode: OrderMode;
  audioStyle: AudioStyle;
  trimSilence: boolean;
  normalize: boolean;
  fadeMs: number;
  fixedNoteLength: number;
  outputSampleRate: number;
  slicexMarkers: boolean;
};

type PrepareSettings = {
  thresholdDb: number;
  minRegionMs: number;
  minSilenceMs: number;
  paddingMs: number;
  outputSampleRate: number;
};

type MonoSound = {
  sampleRate: number;
  data: Float32Array;
};

type SliceMarker = {
  offset: number;
  label: string;
};

type GeneratedFile = {
  name: string;
  url: string;
  size: number;
};

const initialSettings: Settings = {
  startNoteIndex: 0,
  startOctave: 4,
  semitones: 12,
  gapSeconds: 0.05,
  pitchSamples: true,
  dumpSamples: false,
  orderMode: "sequential",
  audioStyle: "Current",
  trimSilence: true,
  normalize: true,
  fadeMs: 5,
  fixedNoteLength: 0,
  outputSampleRate: 48000,
  slicexMarkers: true,
};

const initialPrepareSettings: PrepareSettings = {
  thresholdDb: -40,
  minRegionMs: 80,
  minSilenceMs: 120,
  paddingMs: 20,
  outputSampleRate: 48000,
};

type OptionsFile = {
  version: 1;
  generate: Settings;
  prepare: PrepareSettings;
};

function noteLabel(startNoteIndex: number, startOctave: number, offset: number) {
  const total = startNoteIndex + offset;
  return `${NOTES[total % 12]}${startOctave + Math.floor(total / 12)}`;
}

function noteFrequency(startNoteIndex: number, startOctave: number, offset: number) {
  const baseMidi = (startOctave + 1) * 12 + startNoteIndex;
  const midiNote = baseMidi + offset;
  return 440 * 2 ** ((midiNote - 69) / 12);
}

function dbToAmplitude(dbValue: number) {
  return 10 ** (dbValue / 20);
}

function clampSample(value: number) {
  return Math.max(-1, Math.min(1, value));
}

function listSourceFiles(files: File[]) {
  const wavFiles = files
    .filter((file) => file.name.toLowerCase().endsWith(".wav"))
    .filter((file) => file.name.toLowerCase() !== "chromatic.wav");

  const numbered = wavFiles
    .map((file) => {
      const match = file.name.match(/^(\d+)\.wav$/i);
      return match ? { file, index: Number(match[1]) } : null;
    })
    .filter((entry): entry is { file: File; index: number } => Boolean(entry))
    .sort((a, b) => a.index - b.index);

  if (numbered.length > 0 && numbered[0].index === 1) {
    const contiguous: File[] = [];
    for (let expected = 1; expected <= numbered.length; expected += 1) {
      const found = numbered.find((entry) => entry.index === expected);
      if (!found) break;
      contiguous.push(found.file);
    }
    if (contiguous.length > 0) return contiguous;
  }

  return wavFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function orderedSampleIndexes(count: number, total: number, mode: OrderMode) {
  if (mode === "random") {
    return Array.from({ length: total }, () => Math.floor(Math.random() * count));
  }

  const order = Array.from({ length: count }, (_, index) => index);
  if (mode === "shuffle") {
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
  }

  return Array.from({ length: total }, (_, index) => order[index % count]);
}

async function decodeWav(file: File, targetSampleRate = DEFAULT_SAMPLE_RATE): Promise<MonoSound> {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass({ sampleRate: targetSampleRate });
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const mono = new Float32Array(buffer.length);

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const values = buffer.getChannelData(channel);
      for (let index = 0; index < values.length; index += 1) {
        mono[index] += values[index] / buffer.numberOfChannels;
      }
    }

    const sound = { sampleRate: buffer.sampleRate, data: mono };
    return resampleIfNeeded(sound, targetSampleRate);
  } finally {
    await audioContext.close();
  }
}

function resampleIfNeeded(sound: MonoSound, sampleRate: number): MonoSound {
  if (sound.sampleRate === sampleRate) return sound;
  const ratio = sampleRate / sound.sampleRate;
  const length = Math.max(1, Math.round(sound.data.length * ratio));
  const data = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const sourceIndex = index / ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(sound.data.length - 1, left + 1);
    const amount = sourceIndex - left;
    data[index] = sound.data[left] * (1 - amount) + sound.data[right] * amount;
  }

  return { sampleRate, data };
}

function trimEdgeSilence(sound: MonoSound, thresholdDb = -40, paddingMs = 5): MonoSound {
  const threshold = dbToAmplitude(thresholdDb);
  let start = -1;
  let end = -1;

  for (let index = 0; index < sound.data.length; index += 1) {
    if (Math.abs(sound.data[index]) >= threshold) {
      if (start === -1) start = index;
      end = index;
    }
  }

  if (start === -1 || end === -1) return sound;

  const padding = Math.round((paddingMs * sound.sampleRate) / 1000);
  const trimmedStart = Math.max(0, start - padding);
  const trimmedEnd = Math.min(sound.data.length, end + 1 + padding);

  if (trimmedStart === 0 && trimmedEnd === sound.data.length) return sound;
  return { sampleRate: sound.sampleRate, data: sound.data.slice(trimmedStart, trimmedEnd) };
}

function findAudioRegions(sound: MonoSound, settings: PrepareSettings) {
  const threshold = dbToAmplitude(settings.thresholdDb);
  const minRegion = Math.max(1, Math.round((settings.minRegionMs * sound.sampleRate) / 1000));
  const minSilence = Math.max(1, Math.round((settings.minSilenceMs * sound.sampleRate) / 1000));
  const padding = Math.max(0, Math.round((settings.paddingMs * sound.sampleRate) / 1000));
  const regions: Array<[number, number]> = [];
  let start: number | null = null;
  let lastActive: number | null = null;

  for (let index = 0; index < sound.data.length; index += 1) {
    if (Math.abs(sound.data[index]) >= threshold) {
      if (start === null) start = index;
      lastActive = index;
    } else if (start !== null && lastActive !== null && index - lastActive >= minSilence) {
      if (lastActive - start + 1 >= minRegion) {
        regions.push([Math.max(0, start - padding), Math.min(sound.data.length, lastActive + 1 + padding)]);
      }
      start = null;
      lastActive = null;
    }
  }

  if (start !== null && lastActive !== null && lastActive - start + 1 >= minRegion) {
    regions.push([Math.max(0, start - padding), Math.min(sound.data.length, lastActive + 1 + padding)]);
  }

  return regions;
}

function peakNormalize(sound: MonoSound, targetPeak = 0.98): MonoSound {
  let peak = 0;
  for (const value of sound.data) peak = Math.max(peak, Math.abs(value));
  if (peak <= 1e-9) return sound;

  const data = new Float32Array(sound.data.length);
  const gain = targetPeak / peak;
  for (let index = 0; index < sound.data.length; index += 1) {
    data[index] = clampSample(sound.data[index] * gain);
  }
  return { sampleRate: sound.sampleRate, data };
}

function applyFade(sound: MonoSound, fadeMs: number): MonoSound {
  if (fadeMs <= 0) return sound;
  const data = new Float32Array(sound.data);
  const fadeFrames = Math.min(Math.round((fadeMs * sound.sampleRate) / 1000), Math.floor(data.length / 2));
  if (fadeFrames <= 0) return sound;

  for (let index = 0; index < fadeFrames; index += 1) {
    const fadeIn = index / Math.max(1, fadeFrames - 1);
    const fadeOut = 1 - fadeIn;
    data[index] *= fadeIn;
    data[data.length - 1 - index] *= fadeOut;
  }

  return { sampleRate: sound.sampleRate, data };
}

function padOrTrim(sound: MonoSound, lengthSeconds: number, sampleRate: number): MonoSound {
  if (lengthSeconds <= 0) return sound;
  const current = resampleIfNeeded(sound, sampleRate);
  const targetFrames = Math.max(0, Math.round(lengthSeconds * sampleRate));
  if (current.data.length === targetFrames) return current;

  const data = new Float32Array(targetFrames);
  data.set(current.data.slice(0, targetFrames));
  return { sampleRate, data };
}

function estimatePitch(sound: MonoSound): number | null {
  const data = sound.data;
  const sampleRate = sound.sampleRate;
  const minFreq = 45;
  const maxFreq = 1000;
  const minLag = Math.floor(sampleRate / maxFreq);
  const maxLag = Math.min(Math.floor(sampleRate / minFreq), data.length - 1);
  const windowSize = Math.min(data.length, sampleRate);

  if (windowSize < minLag * 2) return null;

  let bestLag = 0;
  let bestCorrelation = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index < windowSize - lag; index += 1) {
      const left = data[index];
      const right = data[index + lag];
      sum += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const correlation = sum / Math.sqrt(leftEnergy * rightEnergy || 1);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestCorrelation < 0.28) return null;
  return sampleRate / bestLag;
}

function retuneSound(sound: MonoSound, targetFrequency: number, audioStyle: AudioStyle): MonoSound {
  const currentFrequency = estimatePitch(sound);
  if (!currentFrequency || !Number.isFinite(currentFrequency)) return sound;

  const ratio = targetFrequency / currentFrequency;
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(Math.log2(ratio)) < 0.0001) {
    return sound;
  }

  const styleRatio = audioStyle === "OG App" ? ratio : ratio;
  const targetLength = Math.max(1, Math.round(sound.data.length / styleRatio));
  const data = new Float32Array(targetLength);

  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = index * styleRatio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(sound.data.length - 1, left + 1);
    const amount = sourceIndex - left;
    data[index] = sound.data[left] * (1 - amount) + sound.data[right] * amount;
  }

  return { sampleRate: sound.sampleRate, data };
}

function makeSilence(seconds: number, sampleRate: number): MonoSound {
  return { sampleRate, data: new Float32Array(Math.max(0, Math.round(seconds * sampleRate))) };
}

function concatenateSounds(sounds: MonoSound[], sampleRate: number): MonoSound {
  const rendered = sounds.map((sound) => resampleIfNeeded(sound, sampleRate));
  const totalLength = rendered.reduce((sum, sound) => sum + sound.data.length, 0);
  const data = new Float32Array(totalLength);
  let offset = 0;

  for (const sound of rendered) {
    data.set(sound.data, offset);
    offset += sound.data.length;
  }

  return { sampleRate, data };
}

function writeString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function chunk(id: string, body: Uint8Array) {
  const pad = body.length % 2;
  const output = new Uint8Array(8 + body.length + pad);
  const view = new DataView(output.buffer);
  writeString(view, 0, id);
  view.setUint32(4, body.length, true);
  output.set(body, 8);
  return output;
}

function buildMarkerChunks(markers: SliceMarker[]) {
  const cueBody = new Uint8Array(4 + markers.length * 24);
  const cueView = new DataView(cueBody.buffer);
  cueView.setUint32(0, markers.length, true);

  let cueOffset = 4;
  const labelChunks: Uint8Array[] = [];

  markers.forEach((marker, index) => {
    const cueId = index + 1;
    const sampleOffset = Math.max(0, Math.floor(marker.offset));
    cueView.setUint32(cueOffset, cueId, true);
    cueView.setUint32(cueOffset + 4, sampleOffset, true);
    writeString(cueView, cueOffset + 8, "data");
    cueView.setUint32(cueOffset + 12, 0, true);
    cueView.setUint32(cueOffset + 16, 0, true);
    cueView.setUint32(cueOffset + 20, sampleOffset, true);
    cueOffset += 24;

    const encodedLabel = new TextEncoder().encode(marker.label);
    const labelBody = new Uint8Array(4 + encodedLabel.length + 1);
    const labelView = new DataView(labelBody.buffer);
    labelView.setUint32(0, cueId, true);
    labelBody.set(encodedLabel, 4);
    labelChunks.push(chunk("labl", labelBody));
  });

  const listSize = 4 + labelChunks.reduce((sum, item) => sum + item.length, 0);
  const listBody = new Uint8Array(listSize);
  const listView = new DataView(listBody.buffer);
  writeString(listView, 0, "adtl");
  let offset = 4;
  for (const labelChunk of labelChunks) {
    listBody.set(labelChunk, offset);
    offset += labelChunk.length;
  }

  return [chunk("cue ", cueBody), chunk("LIST", listBody)];
}

function encodeWav(sound: MonoSound, markers: SliceMarker[] = []) {
  const sampleRate = sound.sampleRate;
  const pcm = new Uint8Array(sound.data.length * 2);
  const pcmView = new DataView(pcm.buffer);
  for (let index = 0; index < sound.data.length; index += 1) {
    const value = clampSample(sound.data[index]);
    pcmView.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }

  const fmtBody = new Uint8Array(16);
  const fmtView = new DataView(fmtBody.buffer);
  fmtView.setUint16(0, 1, true);
  fmtView.setUint16(2, 1, true);
  fmtView.setUint32(4, sampleRate, true);
  fmtView.setUint32(8, sampleRate * 2, true);
  fmtView.setUint16(12, 2, true);
  fmtView.setUint16(14, 16, true);

  const chunks = [chunk("fmt ", fmtBody), chunk("data", pcm), ...buildMarkerChunks(markers)];
  const riffSize = 4 + chunks.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(8 + riffSize);
  const view = new DataView(output.buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, riffSize, true);
  writeString(view, 8, "WAVE");

  let offset = 12;
  for (const item of chunks) {
    output.set(item, offset);
    offset += item.length;
  }

  return new Blob([output], { type: "audio/wav" });
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const prepareFilesInputRef = useRef<HTMLInputElement>(null);
  const prepareFolderInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<"generate" | "prepare">("generate");
  const [generatePanel, setGeneratePanel] = useState<"source" | "pitch" | "processing">("source");
  const [preparePanel, setPreparePanel] = useState<"source" | "silence">("source");
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [prepareSettings, setPrepareSettings] = useState<PrepareSettings>(initialPrepareSettings);
  const [files, setFiles] = useState<File[]>([]);
  const [sourceName, setSourceName] = useState("");
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [prepareFiles, setPrepareFiles] = useState<File[]>([]);
  const [prepareSourceName, setPrepareSourceName] = useState("");
  const [prepareDirectoryHandle, setPrepareDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [preparedDownloads, setPreparedDownloads] = useState<GeneratedFile[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [prepareLogs, setPrepareLogs] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "Idle" });
  const [prepareProgress, setPrepareProgress] = useState({ done: 0, total: 0, label: "Idle" });
  const [chromatic, setChromatic] = useState<GeneratedFile | null>(null);
  const [dumpedSamples, setDumpedSamples] = useState<GeneratedFile[]>([]);
  const [error, setError] = useState("");
  const [prepareError, setPrepareError] = useState("");

  const sourceFiles = useMemo(() => listSourceFiles(files), [files]);
  const prepareSourceFiles = useMemo(
    () => prepareFiles.filter((file) => file.name.toLowerCase().endsWith(".wav") && file.name.toLowerCase() !== "chromatic.wav"),
    [prepareFiles],
  );
  const canGenerate = sourceFiles.length > 0 && !isGenerating;
  const canPrepare = prepareSourceFiles.length > 0 && !isPreparing;
  const completion = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const prepareCompletion = prepareProgress.total > 0 ? Math.round((prepareProgress.done / prepareProgress.total) * 100) : 0;

  function patchSettings(patch: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function patchPrepareSettings(patch: Partial<PrepareSettings>) {
    setPrepareSettings((current) => ({ ...current, ...patch }));
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    setFiles(selected);
    setSourceName(selected.length ? "Selected files" : "");
    setDirectoryHandle(null);
    setError("");
    setChromatic(null);
    setDumpedSamples([]);
    setLogs(selected.length ? [`Loaded ${listSourceFiles(selected).length} usable WAV file(s).`] : []);
  }

  function handleFolderFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    const firstPath = selected[0]?.webkitRelativePath;
    const folderName = firstPath ? firstPath.split("/")[0] : "Selected folder";
    setFiles(selected);
    setSourceName(selected.length ? folderName : "");
    setDirectoryHandle(null);
    setError("");
    setChromatic(null);
    setDumpedSamples([]);
    setLogs(selected.length ? [`Loaded ${listSourceFiles(selected).length} usable WAV file(s) from ${folderName}.`] : []);
  }

  async function readDirectoryFiles(handle: FileSystemDirectoryHandle) {
    const selected: File[] = [];
    for await (const entry of handle.values()) {
      if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".wav")) {
        selected.push(await entry.getFile());
      }
    }
    return selected;
  }

  async function chooseFolder() {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker();
        const selected = await readDirectoryFiles(handle);
        setFiles(selected);
        setSourceName(handle.name);
        setDirectoryHandle(handle);
        setError("");
        setChromatic(null);
        setDumpedSamples([]);
        setLogs([`Loaded ${listSourceFiles(selected).length} usable WAV file(s) from ${handle.name}.`]);
        return;
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Could not open folder.");
      }
    }

    folderInputRef.current?.click();
  }

  function handlePrepareFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    setPrepareFiles(selected);
    setPrepareSourceName(selected.length === 1 ? selected[0].name : selected.length ? `${selected.length} WAV file(s)` : "");
    setPrepareDirectoryHandle(null);
    setPreparedDownloads([]);
    setPrepareError("");
    setPrepareLogs(
      selected.length
        ? [`Loaded ${selected.filter((file) => file.name.toLowerCase().endsWith(".wav") && file.name.toLowerCase() !== "chromatic.wav").length} usable WAV file(s).`]
        : [],
    );
  }

  function handlePrepareFolderFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    const firstPath = selected[0]?.webkitRelativePath;
    const folderName = firstPath ? firstPath.split("/")[0] : "Selected folder";
    setPrepareFiles(selected);
    setPrepareSourceName(selected.length ? folderName : "");
    setPrepareDirectoryHandle(null);
    setPreparedDownloads([]);
    setPrepareError("");
    setPrepareLogs(selected.length ? [`Loaded ${selected.filter((file) => file.name.toLowerCase().endsWith(".wav") && file.name.toLowerCase() !== "chromatic.wav").length} usable WAV file(s) from ${folderName}.`] : []);
  }

  async function choosePrepareFolder() {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker();
        const selected = await readDirectoryFiles(handle);
        setPrepareFiles(selected);
        setPrepareSourceName(handle.name);
        setPrepareDirectoryHandle(handle);
        setPreparedDownloads([]);
        setPrepareError("");
        setPrepareLogs([`Loaded ${selected.filter((file) => file.name.toLowerCase().endsWith(".wav") && file.name.toLowerCase() !== "chromatic.wav").length} usable WAV file(s) from ${handle.name}.`]);
        return;
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setPrepareError(caught instanceof Error ? caught.message : "Could not open folder.");
      }
    }

    prepareFolderInputRef.current?.click();
  }

  function exportOptions() {
    const options: OptionsFile = {
      version: 1,
      generate: settings,
      prepare: prepareSettings,
    };
    const blob = new Blob([JSON.stringify(options, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "chromakit-options.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importOptions(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;

    try {
      const data = JSON.parse(await file.text()) as Partial<OptionsFile>;
      if (data.generate) setSettings((current) => ({ ...current, ...data.generate }));
      if (data.prepare) setPrepareSettings((current) => ({ ...current, ...data.prepare }));
      setError("");
      setPrepareError("");
      setLogs(["Imported options."]);
      setPrepareLogs(["Imported options."]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not import options.";
      setError(message);
      setPrepareError(message);
    } finally {
      event.currentTarget.value = "";
    }
  }

  function clearOutput() {
    if (chromatic) URL.revokeObjectURL(chromatic.url);
    for (const sample of dumpedSamples) URL.revokeObjectURL(sample.url);
    setChromatic(null);
    setDumpedSamples([]);
    setLogs([]);
    setProgress({ done: 0, total: 0, label: "Idle" });
    setError("");
  }

  function clearPrepareOutput() {
    for (const sample of preparedDownloads) URL.revokeObjectURL(sample.url);
    setPreparedDownloads([]);
    setPrepareLogs([]);
    setPrepareProgress({ done: 0, total: 0, label: "Idle" });
    setPrepareError("");
  }

  async function generate() {
    if (!canGenerate) return;

    clearOutput();
    setIsGenerating(true);
    setProgress({ done: 0, total: settings.semitones, label: "Starting" });

    try {
      setLogs([`Generating 0/${settings.semitones} notes...`]);

      const indexes = orderedSampleIndexes(sourceFiles.length, settings.semitones, settings.orderMode);
      const renderedNotes: MonoSound[] = [];
      const sampleDownloads: GeneratedFile[] = [];
      const markers: SliceMarker[] = [];
      let currentOffset = 0;
      const gap = settings.gapSeconds > 0 ? makeSilence(settings.gapSeconds, settings.outputSampleRate) : null;

      for (let offset = 0; offset < indexes.length; offset += 1) {
        const file = sourceFiles[indexes[offset]];
        const label = noteLabel(settings.startNoteIndex, settings.startOctave, offset);
        setLogs([`Generating ${offset + 1}/${settings.semitones}: ${file.name} -> ${label}`]);

        let sound = await decodeWav(file, DEFAULT_SAMPLE_RATE);
        if (settings.trimSilence) {
          sound = trimEdgeSilence(sound);
        }
        if (settings.normalize) {
          sound = peakNormalize(sound);
        }
        if (settings.pitchSamples) {
          sound = retuneSound(sound, noteFrequency(settings.startNoteIndex, settings.startOctave, offset), settings.audioStyle);
        }
        if (settings.fadeMs > 0) {
          sound = applyFade(sound, settings.fadeMs);
        }
        if (settings.fixedNoteLength > 0) {
          sound = padOrTrim(sound, settings.fixedNoteLength, DEFAULT_SAMPLE_RATE);
        }

        sound = resampleIfNeeded(sound, settings.outputSampleRate);
        if (settings.slicexMarkers) markers.push({ offset: currentOffset, label });
        renderedNotes.push(sound);
        currentOffset += sound.data.length;

        if (settings.dumpSamples) {
          const blob = encodeWav(sound);
          sampleDownloads.push({
            name: `note_${offset + 1}_${label.replace("#", "sharp")}.wav`,
            url: URL.createObjectURL(blob),
            size: blob.size,
          });
        }

        if (gap && offset < indexes.length - 1) {
          renderedNotes.push(gap);
          currentOffset += gap.data.length;
        }

        setProgress({ done: offset + 1, total: settings.semitones, label });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      const output = concatenateSounds(renderedNotes, settings.outputSampleRate);
      const blob = encodeWav(output, settings.slicexMarkers ? markers : []);
      setChromatic({ name: "chromatic.wav", url: URL.createObjectURL(blob), size: blob.size });
      setDumpedSamples(sampleDownloads);
      if (directoryHandle) {
        const outputHandle = await directoryHandle.getFileHandle("chromatic.wav", { create: true });
        const writable = await outputHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        setLogs([`Done: saved chromatic.wav to ${sourceName || directoryHandle.name}.`]);

        if (settings.dumpSamples && sampleDownloads.length > 0) {
          const dumpDirectory = await directoryHandle.getDirectoryHandle(settings.pitchSamples ? "pitched_samples" : "samples", { create: true });
          for (let index = 0; index < sampleDownloads.length; index += 1) {
            const sample = sampleDownloads[index];
            const response = await fetch(sample.url);
            const sampleBlob = await response.blob();
            const sampleHandle = await dumpDirectory.getFileHandle(`note_${index + 1}.wav`, { create: true });
            const sampleWritable = await sampleHandle.createWritable();
            await sampleWritable.write(sampleBlob);
            await sampleWritable.close();
          }
          setLogs([`Done: saved chromatic.wav and ${sampleDownloads.length} dumped sample(s).`]);
        }
      } else {
        setLogs(["Done: chromatic.wav is ready to download."]);
      }
      setProgress({ done: settings.semitones, total: settings.semitones, label: "Done" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Generation failed.";
      setError(message);
      setLogs([`Error: ${message}`]);
    } finally {
      setIsGenerating(false);
    }
  }

  async function prepareSamples() {
    if (!canPrepare) return;

    clearPrepareOutput();
    setIsPreparing(true);
    setPrepareProgress({ done: 0, total: prepareSourceFiles.length, label: "Starting" });

    try {
      setPrepareLogs([`Preparing 0/${prepareSourceFiles.length} file(s)...`]);
      const prepared: GeneratedFile[] = [];
      let outputIndex = 1;
      let outputDirectory: FileSystemDirectoryHandle | null = null;

      if (prepareDirectoryHandle) {
        outputDirectory = await prepareDirectoryHandle.getDirectoryHandle("prepared_samples", { create: true });
      }

      for (let fileIndex = 0; fileIndex < prepareSourceFiles.length; fileIndex += 1) {
        const file = prepareSourceFiles[fileIndex];
        setPrepareLogs([`Preparing ${fileIndex + 1}/${prepareSourceFiles.length}: scanning ${file.name}`]);
        const sound = await decodeWav(file, prepareSettings.outputSampleRate);
        const regions = findAudioRegions(sound, prepareSettings);

        if (regions.length === 0) {
          setPrepareLogs([`Preparing ${fileIndex + 1}/${prepareSourceFiles.length}: no regions in ${file.name}`]);
          setPrepareProgress({ done: fileIndex + 1, total: prepareSourceFiles.length, label: file.name });
          continue;
        }

        for (const [start, end] of regions) {
          const part = { sampleRate: sound.sampleRate, data: sound.data.slice(start, end) };
          const blob = encodeWav(part);
          const name = `${outputIndex}.wav`;
          prepared.push({ name, url: URL.createObjectURL(blob), size: blob.size });

          if (outputDirectory) {
            const fileHandle = await outputDirectory.getFileHandle(name, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
          }

          setPrepareLogs([`Preparing ${fileIndex + 1}/${prepareSourceFiles.length}: wrote ${name}`]);
          outputIndex += 1;
        }

        setPrepareProgress({ done: fileIndex + 1, total: prepareSourceFiles.length, label: file.name });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      if (prepared.length === 0) {
        throw new Error("No non-silent sample regions were found.");
      }

      setPreparedDownloads(prepared);
      setPrepareLogs([
        outputDirectory ? `Done: prepared ${prepared.length} sample(s) in prepared_samples.` : `Done: prepared ${prepared.length} sample(s).`,
      ]);
      setPrepareProgress({ done: prepareSourceFiles.length, total: prepareSourceFiles.length, label: "Done" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Preparation failed.";
      setPrepareError(message);
      setPrepareLogs([`Error: ${message}`]);
    } finally {
      setIsPreparing(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="app-window">
        <header className="window-header">
          <div className="brand-lockup">
            <img src="/chromakit-logo.png" alt="ChromaKit" className="brand-mark" />
            <h1 className="visually-hidden">
              <span>Chroma</span>
              <span>Kit</span>
            </h1>
          </div>
          <div className="header-tools">
            <button className="tool-button text-tool" type="button" onClick={exportOptions}>
              Export Options
            </button>
            <button className="tool-button text-tool" type="button" onClick={() => importInputRef.current?.click()}>
              Import Options
            </button>
            <input ref={importInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={importOptions} />
          </div>
        </header>

        <div className="top-tabs" role="tablist" aria-label="ChromaKit tools">
          <button
            className={`top-tab ${activeTab === "generate" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "generate"}
            onClick={() => setActiveTab("generate")}
          >
            Generate
          </button>
          <button
            className={`top-tab ${activeTab === "prepare" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "prepare"}
            onClick={() => setActiveTab("prepare")}
          >
            Prepare Samples
          </button>
        </div>

      {activeTab === "generate" ? (
      <section className="workspace" aria-label="Generate chromatic scale">
        <div className="settings-tabs" role="tablist" aria-label="Generate settings">
          <button className={`settings-tab ${generatePanel === "source" ? "active" : ""}`} type="button" onClick={() => setGeneratePanel("source")}>
            Source
          </button>
          <button className={`settings-tab ${generatePanel === "pitch" ? "active" : ""}`} type="button" onClick={() => setGeneratePanel("pitch")}>
            Pitch / Range
          </button>
          <button
            className={`settings-tab ${generatePanel === "processing" ? "active" : ""}`}
            type="button"
            onClick={() => setGeneratePanel("processing")}
          >
            Processing
          </button>
        </div>

        {generatePanel === "source" ? (
        <aside className="panel source-panel">
          <div className="panel-title">
            <FileAudio size={18} />
            <h2>Source WAVs</h2>
          </div>

          <input ref={fileInputRef} className="visually-hidden" type="file" accept=".wav,audio/wav" multiple onChange={handleFiles} />
          <input
            ref={folderInputRef}
            className="visually-hidden"
            type="file"
            multiple
            onChange={handleFolderFiles}
            {...{ webkitdirectory: "", directory: "" }}
          />

          <div className="source-actions">
            <button className="secondary-button" type="button" onClick={chooseFolder}>
              Choose Folder
            </button>
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
              Choose WAV Files
            </button>
          </div>

          <div className="source-summary">
            <strong>{sourceFiles.length}</strong>
            <span>usable WAV file{sourceFiles.length === 1 ? "" : "s"}</span>
          </div>

          <div className="file-list" aria-label="Selected source files">
            {sourceFiles.length === 0 ? (
              <p className="empty-state">No WAV files selected yet.</p>
            ) : (
              sourceFiles.slice(0, 12).map((file) => (
                <div className="file-row" key={`${file.name}-${file.size}`}>
                  <Music2 size={16} />
                  <span>{file.name}</span>
                  <small>{formatBytes(file.size)}</small>
                </div>
              ))
            )}
            {sourceFiles.length > 12 ? <p className="overflow-note">+{sourceFiles.length - 12} more files</p> : null}
          </div>
        </aside>
        ) : null}

        {generatePanel !== "source" ? (
        <section className="panel controls-panel">
          <div className="panel-title">
            <AudioLines size={18} />
            <h2>{generatePanel === "pitch" ? "Pitch and Range" : "Processing"}</h2>
          </div>

          {generatePanel === "pitch" ? (
          <div className="control-grid">
            <label>
              <span>Start note</span>
              <select value={settings.startNoteIndex} onChange={(event) => patchSettings({ startNoteIndex: Number(event.target.value) })}>
                {NOTES.map((note, index) => (
                  <option key={note} value={index}>
                    {note}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Octave</span>
              <select value={settings.startOctave} onChange={(event) => patchSettings({ startOctave: Number(event.target.value) })}>
                {OCTAVES.map((octave) => (
                  <option key={octave} value={octave}>
                    {octave}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Range</span>
              <input
                type="number"
                min={1}
                max={128}
                value={settings.semitones}
                onChange={(event) => patchSettings({ semitones: Math.max(1, Math.min(128, Number(event.target.value))) })}
              />
            </label>

            <label>
              <span>Gap seconds</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={settings.gapSeconds}
                onChange={(event) => patchSettings({ gapSeconds: Math.max(0, Number(event.target.value)) })}
              />
            </label>

            <label>
              <span>Order</span>
              <select value={settings.orderMode} onChange={(event) => patchSettings({ orderMode: event.target.value as OrderMode })}>
                {ORDER_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
          </div>
          ) : (
          <>
          <div className="control-grid">

            <label>
              <span>Output rate</span>
              <select value={settings.outputSampleRate} onChange={(event) => patchSettings({ outputSampleRate: Number(event.target.value) })}>
                {SAMPLE_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} Hz
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Audio style</span>
              <select value={settings.audioStyle} onChange={(event) => patchSettings({ audioStyle: event.target.value as AudioStyle })}>
                {AUDIO_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {style}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Fade ms</span>
              <input
                type="number"
                min={0}
                value={settings.fadeMs}
                onChange={(event) => patchSettings({ fadeMs: Math.max(0, Number(event.target.value)) })}
              />
            </label>

            <label>
              <span>Fixed length</span>
              <input
                type="number"
                min={0}
                step={0.05}
                value={settings.fixedNoteLength}
                onChange={(event) => patchSettings({ fixedNoteLength: Math.max(0, Number(event.target.value)) })}
              />
            </label>
          </div>

          <div className="toggle-grid">
            <Toggle label="Pitch samples" checked={settings.pitchSamples} onChange={(pitchSamples) => patchSettings({ pitchSamples })} />
            <Toggle label="Dump samples" checked={settings.dumpSamples} onChange={(dumpSamples) => patchSettings({ dumpSamples })} />
            <Toggle label="Trim silence" checked={settings.trimSilence} onChange={(trimSilence) => patchSettings({ trimSilence })} />
            <Toggle label="Normalize" checked={settings.normalize} onChange={(normalize) => patchSettings({ normalize })} />
            <Toggle label="SliceX markers" checked={settings.slicexMarkers} onChange={(slicexMarkers) => patchSettings({ slicexMarkers })} />
          </div>

          <div className="action-row">
            <button className="primary-button" type="button" disabled={!canGenerate} onClick={generate}>
              {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              Generate Chromatic
            </button>
            <button className="secondary-button" type="button" onClick={clearOutput} disabled={isGenerating}>
              <RefreshCcw size={18} />
              Reset Output
            </button>
          </div>

          {error ? (
            <div className="error-box" role="alert">
              <X size={18} />
              {error}
            </div>
          ) : null}
          </>
          )}
        </section>
        ) : null}

        <aside className="panel output-panel">
          <div className="panel-title">
            <AudioLines size={18} />
            <h2>Output</h2>
          </div>

          {chromatic ? (
            <a className="download-card" href={chromatic.url} download={chromatic.name}>
              <Download size={20} />
              <span>
                <strong>{chromatic.name}</strong>
                <small>{formatBytes(chromatic.size)}</small>
              </span>
            </a>
          ) : (
            <div className="empty-output">
              <Check size={18} />
              <span>Generated files will appear here.</span>
            </div>
          )}

          {dumpedSamples.length > 0 ? (
            <div className="sample-downloads">
              <h3>Dumped samples</h3>
              {dumpedSamples.map((sample) => (
                <a key={sample.name} href={sample.url} download={sample.name}>
                  {sample.name}
                  <small>{formatBytes(sample.size)}</small>
                </a>
              ))}
            </div>
          ) : null}

          <div className="log-box" aria-live="polite">
            {logs.length === 0 ? <p>Logs will appear here.</p> : logs.map((log, index) => <p key={`${log}-${index}`}>{log}</p>)}
          </div>
        </aside>
      </section>
      ) : (
      <section className="workspace" aria-label="Prepare samples">
        <div className="settings-tabs" role="tablist" aria-label="Prepare settings">
          <button className={`settings-tab ${preparePanel === "source" ? "active" : ""}`} type="button" onClick={() => setPreparePanel("source")}>
            Source
          </button>
          <button className={`settings-tab ${preparePanel === "silence" ? "active" : ""}`} type="button" onClick={() => setPreparePanel("silence")}>
            Silence
          </button>
        </div>

        {preparePanel === "source" ? (
        <aside className="panel source-panel">
          <div className="panel-title">
            <FileAudio size={18} />
            <h2>Source WAVs</h2>
          </div>

          <input ref={prepareFilesInputRef} className="visually-hidden" type="file" accept=".wav,audio/wav" multiple onChange={handlePrepareFiles} />
          <input
            ref={prepareFolderInputRef}
            className="visually-hidden"
            type="file"
            multiple
            onChange={handlePrepareFolderFiles}
            {...{ webkitdirectory: "", directory: "" }}
          />

          <div className="source-actions">
            <button className="secondary-button" type="button" onClick={choosePrepareFolder}>
              Choose Folder
            </button>
            <button className="secondary-button" type="button" onClick={() => prepareFilesInputRef.current?.click()}>
              Choose WAV Files
            </button>
          </div>

          <div className="source-summary">
            <strong>{prepareSourceFiles.length}</strong>
            <span>usable WAV file{prepareSourceFiles.length === 1 ? "" : "s"}</span>
          </div>

          <div className="file-list" aria-label="Selected prepare source files">
            {prepareSourceFiles.length === 0 ? (
              <p className="empty-state">No WAV files selected yet.</p>
            ) : (
              prepareSourceFiles.slice(0, 12).map((file) => (
                <div className="file-row" key={`${file.name}-${file.size}`}>
                  <Music2 size={16} />
                  <span>{file.name}</span>
                  <small>{formatBytes(file.size)}</small>
                </div>
              ))
            )}
            {prepareSourceFiles.length > 12 ? <p className="overflow-note">+{prepareSourceFiles.length - 12} more files</p> : null}
          </div>
        </aside>
        ) : null}

        {preparePanel === "silence" ? (
        <section className="panel controls-panel">
          <div className="panel-title">
            <AudioLines size={18} />
            <h2>Silence Detection</h2>
          </div>

          <div className="control-grid">
            <label>
              <span>Silence threshold</span>
              <input
                type="number"
                min={-90}
                max={-1}
                value={prepareSettings.thresholdDb}
                onChange={(event) => patchPrepareSettings({ thresholdDb: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>Minimum sample length</span>
              <input
                type="number"
                min={1}
                value={prepareSettings.minRegionMs}
                onChange={(event) => patchPrepareSettings({ minRegionMs: Math.max(1, Number(event.target.value)) })}
              />
            </label>
            <label>
              <span>Minimum silence gap</span>
              <input
                type="number"
                min={1}
                value={prepareSettings.minSilenceMs}
                onChange={(event) => patchPrepareSettings({ minSilenceMs: Math.max(1, Number(event.target.value)) })}
              />
            </label>
            <label>
              <span>Padding</span>
              <input
                type="number"
                min={0}
                value={prepareSettings.paddingMs}
                onChange={(event) => patchPrepareSettings({ paddingMs: Math.max(0, Number(event.target.value)) })}
              />
            </label>
            <label>
              <span>Output sample rate</span>
              <select
                value={prepareSettings.outputSampleRate}
                onChange={(event) => patchPrepareSettings({ outputSampleRate: Number(event.target.value) })}
              >
                {SAMPLE_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} Hz
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="action-row">
            <button className="primary-button" type="button" disabled={!canPrepare} onClick={prepareSamples}>
              {isPreparing ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              Prepare Samples
            </button>
            <button className="secondary-button" type="button" onClick={clearPrepareOutput} disabled={isPreparing}>
              <RefreshCcw size={18} />
              Reset Output
            </button>
          </div>

          {prepareError ? (
            <div className="error-box" role="alert">
              <X size={18} />
              {prepareError}
            </div>
          ) : null}
        </section>
        ) : null}

        <aside className="panel output-panel">
          <div className="panel-title">
            <AudioLines size={18} />
            <h2>Output</h2>
          </div>

          <div className="progress-track" aria-label={`Preparation progress ${prepareCompletion}%`}>
            <span style={{ width: `${prepareCompletion}%` }} />
          </div>

          {preparedDownloads.length > 0 ? (
            <div className="sample-downloads visible-list">
              <h3>Prepared samples</h3>
              {preparedDownloads.map((sample) => (
                <a key={sample.name} href={sample.url} download={sample.name}>
                  {sample.name}
                  <small>{formatBytes(sample.size)}</small>
                </a>
              ))}
            </div>
          ) : (
            <div className="empty-output">
              <Check size={18} />
              <span>Prepared samples will appear here.</span>
            </div>
          )}

          <div className="log-box" aria-live="polite">
            {prepareLogs.length === 0 ? (
              <p>Preparation logs will appear here.</p>
            ) : (
              prepareLogs.map((log, index) => <p key={`${log}-${index}`}>{log}</p>)
            )}
          </div>
        </aside>
      </section>
      )}
      <footer className="status-bar">
        {activeTab === "generate" ? (
          <>
            <span>{isGenerating ? "Generating..." : chromatic ? "Done" : "Idle"}</span>
            <span>{progress.label}</span>
          </>
        ) : (
          <>
            <span>{isPreparing ? "Preparing..." : preparedDownloads.length ? "Done" : "Idle"}</span>
            <span>{prepareProgress.label}</span>
          </>
        )}
      </footer>
      </section>
    </main>
  );
}

type ToggleProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export default App;
