import { pipeline } from "@huggingface/transformers";

type Request = { type: "warmup" } | { type: "transcribe"; id: number; audio: Float32Array };
type Reply = { type: "status"; message: string; progress?: number } | { type: "ready" } | { type: "result"; id: number; text: string } | { type: "error"; id?: number; message: string };
type Transcriber = (audio: Float32Array, options?: { chunk_length_s?: number; stride_length_s?: number; task?: "transcribe" }) => Promise<{ text: string }>;
const worker = self as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(message: Reply): void };
let model: Promise<Transcriber> | undefined;

const loadModel = (): Promise<Transcriber> => {
  if (!model) {
    worker.postMessage({ type: "status", message: "Loading local speech model; first use downloads it" });
    model = pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", {
      dtype: "q8",
      progress_callback: (event) => { if (event.status === "progress_total" && typeof event.progress === "number") worker.postMessage({ type: "status", message: "Downloading speech model", progress: event.progress }); }
    }).then((pipe) => pipe as unknown as Transcriber).catch((problem) => { model = undefined; throw problem; });
  }
  return model;
};

worker.onmessage = async ({ data }) => {
  if (data.type === "warmup") {
    try { await loadModel(); worker.postMessage({ type: "ready" }); }
    catch (problem) { worker.postMessage({ type: "error", message: problem instanceof Error ? problem.message : "Local speech model could not be loaded" }); }
    return;
  }
  try {
    const transcriber = await loadModel();
    const result = await transcriber(data.audio, { chunk_length_s: 30, stride_length_s: 5, task: "transcribe" });
    worker.postMessage({ type: "result", id: data.id, text: result.text });
  } catch (problem) { worker.postMessage({ type: "error", id: data.id, message: problem instanceof Error ? problem.message : "Local speech transcription failed" }); }
};
