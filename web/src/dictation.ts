type DictationReply = { type: "status"; message: string; progress?: number } | { type: "ready" } | { type: "result"; id: number; text: string } | { type: "error"; id?: number; message: string };
type PendingTranscription = { id: number; resolve: (text: string) => void; reject: (error: Error) => void };

export class Dictation {
  private held = false;
  private toggled = false;
  private toggleKeyUp = false;
  private active = false;
  private preparing = false;
  private transcribing = false;
  private modelReady = false;
  private requestId = 0;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private worker?: Worker;
  private pending?: PendingTranscription;
  private target?: HTMLInputElement | HTMLTextAreaElement;
  private keyCaptured = false;

  constructor(private input: () => HTMLInputElement | HTMLTextAreaElement | null, private status: (message: string) => void) {
    window.addEventListener("keydown", this.keyDown, true);
    window.addEventListener("keyup", this.keyUp, true);
  }

  private keyDown = (event: KeyboardEvent): void => {
    if (event.code !== "KeyV" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    this.keyCaptured = true;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.shiftKey) {
      this.toggleKeyUp = true;
      this.toggled = !this.toggled;
      if (this.toggled) void this.start();
      else this.stop();
      return;
    }
    this.held = true;
    if (!this.toggled) void this.start();
  };

  private keyUp = (event: KeyboardEvent): void => {
    if (event.code !== "KeyV" || !this.keyCaptured) return;
    this.keyCaptured = false;
    if (this.toggleKeyUp) { this.toggleKeyUp = false; return; }
    this.held = false;
    if (!this.toggled) this.stop();
  };

  private async start(): Promise<void> {
    if (this.preparing || this.active || this.transcribing) return;
    const focused = document.activeElement;
    const target = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : this.input();
    if (!target || target.disabled || target.readOnly || (target instanceof HTMLInputElement && target.type === "password")) {
      this.held = this.toggled = false;
      this.status("Focus a chat or prompt field first");
      return;
    }
    this.target = target;
    this.preparing = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording is unavailable in this browser");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!this.held && !this.toggled) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const recorder = new MediaRecorder(stream);
      this.recorder = recorder;
      this.chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
      recorder.onstart = () => { this.active = true; this.status("Microphone listening"); this.warmModel(); };
      recorder.onerror = () => { this.held = this.toggled = false; this.releaseStream(recorder); this.status("Microphone recording failed"); };
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.chunks = [];
        this.releaseStream(recorder);
        if (blob.size) void this.transcribeRecording(blob);
        else this.status("No speech captured");
      };
      recorder.start();
    } catch (problem) {
      this.held = this.toggled = false;
      this.releaseStream();
      this.status(problem instanceof DOMException && problem.name === "NotAllowedError" ? "Microphone permission was denied" : problem instanceof Error ? problem.message : "Voice input failed to start");
    } finally { this.preparing = false; }
  }

  private stop(): void {
    if (this.preparing) { this.status("Microphone off"); return; }
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") { this.releaseStream(); return; }
    this.status("Transcribing locally");
    try { recorder.stop(); } catch { this.releaseStream(recorder); this.status("Voice recording could not be stopped"); }
  }

  private releaseStream(recorder?: MediaRecorder): void {
    if (recorder && this.recorder !== recorder) return;
    if (!recorder || this.recorder === recorder) this.recorder = undefined;
    this.active = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  private workerClient(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./dictation_worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<DictationReply>) => {
      const message = event.data;
      if (message.type === "status") { this.status(message.progress === undefined ? message.message : `${message.message} ${Math.round(message.progress)}%`); return; }
      if (message.type === "ready") { this.modelReady = true; if (this.active) this.status("Microphone listening"); return; }
      const pending = this.pending;
      if (!pending || pending.id !== message.id) { if (message.type === "error") this.status(message.message); return; }
      this.pending = undefined;
      if (message.type === "error") pending.reject(new Error(message.message));
      else pending.resolve(message.text);
    };
    worker.onerror = () => {
      this.pending?.reject(new Error("Local speech transcription failed"));
      this.pending = undefined;
      this.worker?.terminate();
      this.worker = undefined;
      this.modelReady = false;
      this.status("Local speech transcription failed");
    };
    this.worker = worker;
    return worker;
  }

  private warmModel(): void {
    try { if (!this.modelReady) this.workerClient().postMessage({ type: "warmup" }); }
    catch { this.status("Local speech model could not be loaded"); }
  }

  private async transcribeRecording(blob: Blob): Promise<void> {
    this.transcribing = true;
    this.status(this.modelReady ? "Transcribing locally" : "Loading local speech model; first use downloads it");
    try {
      const samples = await this.toSamples(blob);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      if (samples.length < 4000 || Math.sqrt(energy / samples.length) < 0.003) { this.status("No speech detected"); return; }
      const transcript = await this.transcribe(samples);
      this.insert(transcript);
      this.status(transcript.trim() ? "Dictation added" : "No speech detected");
    } catch (problem) { this.status(problem instanceof Error ? problem.message : "Local speech transcription failed"); }
    finally { this.transcribing = false; if (this.held || this.toggled) void this.start(); }
  }

  private async toSamples(blob: Blob): Promise<Float32Array> {
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const length = Math.max(1, Math.ceil(decoded.duration * 16000));
      const resampler = new OfflineAudioContext(1, length, 16000);
      const source = resampler.createBufferSource();
      source.buffer = decoded;
      source.connect(resampler.destination);
      source.start();
      return (await resampler.startRendering()).getChannelData(0).slice();
    } finally { await context.close(); }
  }

  private transcribe(samples: Float32Array): Promise<string> {
    const worker = this.workerClient(), id = ++this.requestId;
    return new Promise((resolve, reject) => { this.pending = { id, resolve, reject }; worker.postMessage({ type: "transcribe", id, audio: samples }); });
  }

  private insert(transcript: string): void {
    const target = this.target;
    const text = transcript.trim();
    if (!target?.isConnected || !text) return;
    const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
    target.setRangeText(`${text} `, start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
