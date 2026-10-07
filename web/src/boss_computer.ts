import type { AgentProfile, Api, Terminal } from "./api";
import type { Office, Seat } from "./office";
import type { DesktopPreview } from "./terminal_screen";
import { subtractVideoOcclusion, type YouTubePlayback, type YouTubeTarget } from "./youtube";
import { OWNER_LAPTOP_ICON_KEY, isCustomLaptopIcon, modelIconOptions, modelIconPath, readCustomLaptopIcon } from "./model_icons";
import type { SeasonOption } from "./weather";
import type { WallArtPlacement } from "./wall_art";
import { enableAppOrdering } from "./app_order";

function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value.trim());
    const id = url.hostname === "youtu.be" ? url.pathname.slice(1).split("/")[0] : url.searchParams.get("v") ?? /^\/(?:embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
    return /^[\w-]{11}$/.test(id) ? id : "";
  } catch { return ""; }
}

function readDesktopWallpaper(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("Choose an image file."));
  if (file.size > 20 * 1024 * 1024) return Promise.reject(new Error("Images must be 20 MB or smaller."));
  return createImageBitmap(file).then((bitmap) => {
    const scale = Math.min(1, 1600 / bitmap.width, 900 / bitmap.height), canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); throw new Error("Could not process this image."); }
    context.fillStyle = "#101a2b"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.8);
  });
}

export interface OfficeState { lightsOn: boolean; lightRows: [boolean, boolean, boolean]; stickyNotes: string[]; breakroomOn: boolean; blindStage: number; blindStages: Record<string, number>; season: SeasonOption; wallArt: WallArtPlacement[]; officeClosed: boolean }
interface MusicTrack { id: string; name: string }
interface DesktopWallpaper { color?: string; image?: string }

export class BossComputer {
  private static nextDesktopPreviewId = 0;
  private root = document.createElement("section");
  private workspace: HTMLElement = document.createElement("div");
  private appWindows = new Map<string, { root: HTMLElement; content: HTMLElement; taskbar: HTMLButtonElement; maximized: boolean }>();
  private appWindowZ = 8;
  private desktopCaptureTimer = 0;
  private desktopCaptureSequence = 0;
  private desktopCapturing = false;
  private desktopCapturePending?: DesktopPreview;
  private desktopCaptureAt = -750;
  private desktopScrollPositions = new WeakMap<HTMLElement, { left: number; top: number }>();
  private desktopSnapshotSequence = 0;
  private desktopSnapshot?: HTMLCanvasElement;
  private desktopVideoRect?: DesktopPreview["videoRect"];
  private desktopVideoClipRect?: DesktopPreview["videoClipRect"];
  private desktopVideoVisibleRects?: DesktopPreview["videoVisibleRects"];
  private desktopObserver?: MutationObserver;
  private refreshIconGrid: () => void = () => {};
  private profiles: AgentProfile[] = [];
  private hireWorker: (container?: HTMLElement) => void = () => {};
  private cwd = "";
  private lidOpen = false;
  private state: OfficeState = { lightsOn: true, lightRows: [true, true, true], stickyNotes: Array<string>(13).fill(""), breakroomOn: true, blindStage: 0, blindStages: {}, season: "auto", wallArt: [], officeClosed: false };
  private playYouTube: (id: string, slot: HTMLElement) => void = () => {};
  private setYouTubeTarget: (target: YouTubeTarget) => void = () => {};
  private stopYouTube: () => void = () => {};
  private attachYouTubeSlot: (slot: HTMLElement) => void = () => {};
  private youtubePlayback?: Readonly<YouTubePlayback>;
  private youtubePlaybackSignature = "";
  private youtubeCastAction: () => void = () => {};
  private youtubeCastActive = false;
  private youtubePlaying = false;
  private rememberBlindStages: (change: Partial<OfficeState>) => void = () => {};

  constructor(private api: Api, private office: Office, readonly windowLayer: HTMLElement, private openTerminal: (terminal: Terminal, layer?: HTMLElement) => void, private openWhiteboard: () => void, private error: (message: string) => void, private onLeave: () => void, private onOfficeClosed: (closed: boolean) => void = () => {}, private mode: "owner" | "worker" = "owner", private workerTerminal?: Terminal, private workerSeat?: Seat, private onWorkerClose: () => void = () => {}, private onDesktopScreen: (preview: DesktopPreview) => void = () => {}, private onHangPicture: () => void = () => {}) {
    this.root.id = "boss-computer";
    this.root.dataset.desktopPreviewId = String(++BossComputer.nextDesktopPreviewId);
    this.root.className = "panel office-desktop";
    this.root.innerHTML = `<header class="pc-titlebar"><span>Office PC</span><button data-lid aria-label="Open laptop lid">Open lid</button><button data-close aria-label="Close PC">×</button></header><div class="desktop-body"><div class="desktop-wallpaper"></div><nav class="desktop-icons"></nav><section class="desktop-start-menu"><input data-start-search placeholder="Search apps"><div data-start-apps></div></section><footer class="desktop-taskbar"><button data-start aria-label="Start">⊞</button><button data-search>Search</button><div class="desktop-pinned"></div><div class="desktop-tray"><time></time><small></small></div></footer><div class="desktop-lid-screen">Laptop lid closed</div></div>`;
    this.applyDesktopWallpaper();
    if (this.mode === "owner") { const icon = localStorage.getItem(OWNER_LAPTOP_ICON_KEY) ?? ""; this.office.setLaptopIcon(this.office.bossLaptop, modelIconPath(icon), "#e8a27f"); }
    if (this.mode === "worker") this.root.querySelector(".pc-titlebar span")!.textContent = `${this.workerTerminal?.title ?? "Agent"} — Desktop`;
    this.workspace.className = "desktop-workspace";
    this.windowLayer.className = "desktop-window-layer";
    this.root.querySelector(".desktop-body")!.append(this.workspace, this.windowLayer);
    this.root.querySelector<HTMLButtonElement>("[data-lid]")!.addEventListener("click", () => this.setLidOpen(!this.lidOpen));
    this.root.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    if (this.mode === "owner") document.body.appendChild(this.root);
    this.desktopObserver = new MutationObserver((records) => { if (records.some((record) => { const element = record.target instanceof Element ? record.target : record.target.parentElement; return element && !element.closest(".desktop-tray") && !(record.type === "attributes" && element.closest(".xterm")); })) this.refreshDesktopScreen(); });
    this.desktopObserver.observe(this.root, { attributes: true, childList: true, characterData: true, subtree: true, attributeFilter: ["class", "style"] });
    for (const event of ["input", "change", "scroll"]) this.root.addEventListener(event, () => this.refreshDesktopScreen(), { capture: true, passive: true });
    const icons = this.root.querySelector<HTMLElement>(".desktop-icons")!;
    const startMenu = this.root.querySelector(".desktop-start-menu")!;
    const startApps = this.root.querySelector<HTMLElement>("[data-start-apps]")!;
    const iconSvg = (kind: string) => ({
      command: `<rect x="3" y="4" width="26" height="24" rx="3" fill="#111c2b"/><path d="m9 11 5 5-5 5m8 0h7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      powershell: `<rect x="3" y="4" width="26" height="24" rx="3" fill="#147cba"/><path d="m8 11 5 5-5 5m9 0h5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      sessions: `<rect x="4" y="5" width="24" height="22" rx="3" fill="#256b9b"/><path d="M9 11h14M9 16h14M9 21h9" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
      controls: `<path d="M5 8h22M5 16h22M5 24h22" stroke="#e8edf2" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="8" r="3" fill="#3a94ce"/><circle cx="21" cy="16" r="3" fill="#3a94ce"/><circle cx="10" cy="24" r="3" fill="#3a94ce"/>`,
      hire: `<circle cx="13" cy="10" r="6" fill="#d4e4f2"/><path d="M3 29c1-7 5-10 10-10s9 3 10 10" fill="#3b8ab8"/><path d="M25 11v12m-6-6h12" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`,
      board: `<rect x="4" y="5" width="24" height="20" rx="2" fill="#f5f1e7"/><path d="m10 18 5-6 4 4 3-3m-10 15 3-3m8 3-3-3" fill="none" stroke="#34475c" stroke-width="2" stroke-linecap="round"/>`,
      music: `<path d="M19 5v17a5 5 0 1 1-2-4V9l11-2v12a5 5 0 1 1-2-4V4z" fill="#42a4d8" stroke="#d8f0fb" stroke-width="1.5"/>`,
      youtube: `<rect x="2" y="5" width="28" height="22" rx="6" fill="#e62117"/><path d="m13 10 9 6-9 6z" fill="#fff"/>`,
      games: `<rect x="3" y="7" width="26" height="18" rx="5" fill="#236c9e"/><path d="M10 12v8m-4-4h8m7-2h.1m4 4h.1" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
      art: `<rect x="4" y="4" width="24" height="24" rx="2" fill="#e9b949"/><rect x="7" y="7" width="18" height="18" fill="#fffaf3"/><path d="m8 22 5-6 4 4 3-4 5 6" fill="#6a9c78"/>`,
      settings: `<circle cx="16" cy="16" r="10" fill="#526f87"/><circle cx="16" cy="16" r="4" fill="#e8edf2"/><path d="M16 2v4m0 20v4M2 16h4m20 0h4M6 6l3 3m14 14 3 3M26 6l-3 3M9 23l-3 3" stroke="#e8edf2" stroke-width="2.4" stroke-linecap="round"/>`
    } as Record<string, string>)[kind] ?? "";
    const ownerApps = [
      ["Command Prompt", "command", () => void this.launch("windows-cmd")],
      ["PowerShell", "powershell", () => void this.launch("system-shell")],
      ["Sessions", "sessions", () => void this.showSessions()],
      ["Office controls", "controls", () => this.showControls()],
      ["Hire worker", "hire", () => this.hireWorker(this.openAppWindow("hire", "Hire worker"))],
      ["Whiteboard", "board", () => this.openWhiteboard()],
      ["Music", "music", () => void this.showMusic()],
      ["YouTube", "youtube", () => this.showYouTube()],
      ["Settings", "settings", () => this.showSettings()],
      ["Paintings", "art", () => this.showWallArt()],
      ["Games", "games", () => this.showGames()]
    ] as [string, string, () => void][];
    const workerApps = [["Agent session", "sessions", () => this.openWorkerSession()], ["Command Prompt", "command", () => void this.launch("windows-cmd")], ["PowerShell", "powershell", () => void this.launch("system-shell")], ["Sessions", "sessions", () => void this.showSessions()], ["Music", "music", () => void this.showMusic()], ["YouTube", "youtube", () => this.showYouTube()], ["Settings", "settings", () => this.showSettings()], ["Games", "games", () => this.showGames()]] as [string, string, () => void][];
    const apps = this.mode === "owner" ? ownerApps : workerApps;
    const icon = (label: string, kind: string, action: () => void, parent = icons) => {
      const button = document.createElement("button");
      if (parent === icons) button.dataset.appOrderId = label === "Agent session" ? "agent-session" : kind;
      const picture = document.createElement("span");
      const caption = document.createElement("span");
      picture.className = "app-symbol";
      picture.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true">${iconSvg(kind)}</svg>`;
      caption.textContent = label;
      button.append(picture, caption);
      button.addEventListener("click", () => { startMenu.classList.remove("open"); action(); });
      parent.appendChild(button);
      return button;
    };
    apps.forEach(([label, kind, action]) => icon(label, kind, action));
    const iconStorageKey = this.mode === "owner" ? "agent-office-owner-desktop-apps" : `agent-office-worker-desktop-apps-${this.workerTerminal?.id ?? "default"}`;
    const legacyIconStorageKey = this.mode === "owner" ? "agent-office-owner-desktop-app-order" : `agent-office-worker-desktop-app-order-${this.workerTerminal?.id ?? "default"}`;
    const sizeIconGrid = () => {
      const body = this.root.querySelector<HTMLElement>(".desktop-body")!, style = getComputedStyle(icons), width = Math.max(1, icons.clientWidth || (body.clientWidth || Math.min(window.innerWidth * 0.96, 1180) - 2) - (Number.parseFloat(style.left) || 0) - (Number.parseFloat(style.right) || 0)), height = Math.max(1, icons.clientHeight || (body.clientHeight || Math.min(window.innerHeight * 0.88, 760) - 36) - (Number.parseFloat(style.top) || 0) - (Number.parseFloat(style.bottom) || 0)), gap = Number.parseFloat(style.columnGap) || 6;
      let columns = Math.max(1, Math.floor((width + gap) / 88)), rows = Math.max(1, Math.floor((height + gap) / 81));
      while (columns * rows < apps.length) { if ((width - columns * gap) / (columns + 1) >= 64) columns++; else rows++; }
      const cellWidth = (width - (columns - 1) * gap) / columns, cellHeight = (height - (rows - 1) * gap) / rows, compact = cellHeight < 72 || cellWidth < 64, font = compact ? 10 : 11, padding = compact ? 2 : 5, iconGap = compact ? 2 : 4, symbol = Math.max(16, Math.min(38, cellHeight - padding * 2 - iconGap - font * 2.3 - 2));
      icons.style.gridTemplateColumns = Array(columns).fill(`${cellWidth}px`).join(" "); icons.style.gridTemplateRows = Array(rows).fill(`${cellHeight}px`).join(" ");
      icons.style.setProperty("--desktop-icon-font", `${font}px`); icons.style.setProperty("--desktop-icon-padding", `${padding}px`); icons.style.setProperty("--desktop-icon-gap", `${iconGap}px`); icons.style.setProperty("--desktop-symbol-size", `${symbol}px`);
      icons.scrollTop = icons.scrollLeft = 0; this.refreshIconGrid();
    };
    sizeIconGrid();
    this.refreshIconGrid = enableAppOrdering(icons, iconStorageKey, "column", false, legacyIconStorageKey, 14, true);
    new ResizeObserver(sizeIconGrid).observe(this.root.querySelector<HTMLElement>(".desktop-body")!);
    window.addEventListener("resize", sizeIconGrid);
    apps.forEach(([label, kind, action]) => icon(label, kind, action, startApps));
    const pinned = this.root.querySelector<HTMLElement>(".desktop-pinned")!;
    apps.slice(0, 4).forEach(([label, kind, action]) => icon(label, kind, action, pinned));
    this.root.querySelector("[data-start]")!.addEventListener("click", () => startMenu.classList.toggle("open"));
    this.root.querySelector("[data-search]")!.addEventListener("click", () => { startMenu.classList.add("open"); this.root.querySelector<HTMLInputElement>("[data-start-search]")!.focus(); });
    this.root.querySelector<HTMLInputElement>("[data-start-search]")!.addEventListener("input", (event) => {
      const query = (event.currentTarget as HTMLInputElement).value.toLowerCase();
      for (const button of Array.from(startApps.querySelectorAll("button"))) button.hidden = !button.textContent?.toLowerCase().includes(query);
    });
    const updateClock = () => {
      const now = new Date();
      this.root.querySelector(".desktop-tray time")!.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      this.root.querySelector(".desktop-tray small")!.textContent = now.toLocaleDateString([], { month: "numeric", day: "numeric", year: "numeric" });
    };
    updateClock();
    window.setInterval(updateClock, 30000);
  }

  get isOpen(): boolean { return this.root.classList.contains("open"); }

  setYouTubeHandlers(play: (id: string, slot: HTMLElement) => void, setTarget: (target: YouTubeTarget) => void, stop: () => void, attach: (slot: HTMLElement) => void = () => {}): void { this.playYouTube = play; this.setYouTubeTarget = setTarget; this.stopYouTube = stop; this.attachYouTubeSlot = attach; }
  syncYouTubePlayback(state: Readonly<YouTubePlayback>): void {
    const signature = `${state.videoId}|${state.title}|${state.target}|${state.state}|${state.ready}|${state.error}|${state.autoplayBlocked}`;
    if (signature === this.youtubePlaybackSignature) return;
    this.youtubePlaybackSignature = signature; this.youtubePlayback = { ...state }; this.youtubePlaying = !!state.videoId; this.youtubeCastActive = this.youtubePlaying && state.target === "tv";
    const app = this.appWindows.get("youtube");
    if (!app?.root.classList.contains("open")) return;
    const button = app.root.querySelector<HTMLButtonElement>('[data-action="cast"]'), slot = app.content.querySelector<HTMLElement>(".youtube-video-slot"), empty = app.content.querySelector<HTMLElement>(".youtube-empty-player"), title = app.content.querySelector<HTMLElement>(".youtube-video-title"), status = app.content.querySelector<HTMLElement>(".youtube-playback-status"), url = app.content.querySelector<HTMLInputElement>(".youtube-search-input");
    if (button) { button.disabled = !this.youtubePlaying; button.textContent = this.youtubeCastActive ? "Cast off" : "Cast"; button.title = this.youtubeCastActive ? "Stop casting" : "Cast to Office TV"; button.setAttribute("aria-label", button.title); button.classList.toggle("casting", this.youtubeCastActive); }
    if (slot) slot.hidden = !this.youtubePlaying || this.youtubeCastActive;
    if (empty) empty.hidden = this.youtubePlaying;
    if (title) title.textContent = state.title || (state.videoId ? `YouTube video · ${state.videoId}` : "Watch");
    if (url && state.videoId && document.activeElement !== url) url.value = `https://www.youtube.com/watch?v=${state.videoId}`;
    if (status) status.textContent = !this.youtubePlaying ? "Paste a YouTube link to start watching." : state.error || (state.autoplayBlocked ? "Click the player to start playback." : !state.ready ? "Loading video…" : this.youtubeCastActive ? "Casting to Office TV." : state.state === 2 ? "Paused." : state.state === 0 ? "Video ended." : state.state === 3 ? "Buffering…" : state.state === 1 ? "Playing." : "Ready to play.");
    this.refreshDesktopScreen();
  }
  setBlindStagesFallbackHandler(handler: (change: Partial<OfficeState>) => void): void { this.rememberBlindStages = handler; }

  private setYouTubeCasting(active: boolean): void {
    this.youtubeCastActive = active; this.setYouTubeTarget(active ? "tv" : "auto");
    const button = this.appWindows.get("youtube")?.root.querySelector<HTMLButtonElement>('[data-action="cast"]');
    if (button) { button.disabled = !this.youtubePlaying; button.textContent = active ? "Cast off" : "Cast"; button.title = active ? "Stop casting" : "Cast to Office TV"; button.setAttribute("aria-label", button.title); button.classList.toggle("casting", active); }
    if (active) { this.rememberDesktopScroll(); this.root.classList.remove("open"); document.body.classList.remove("boss-computer-open", "terminal-open"); }
  }

  updateWorkerTerminal(terminal: Terminal): void {
    if (this.mode !== "worker" || terminal.id !== this.workerTerminal?.id) return;
    this.workerTerminal = terminal;
    this.root.querySelector(".pc-titlebar span")!.textContent = `${terminal.title} — Desktop`;
    this.cwd = terminal.cwd || this.cwd;
    this.refreshDesktopScreen();
  }

  refreshDesktopScreen(): void {
    const apps = [...this.appWindows.entries()].filter(([, app]) => app.root.classList.contains("open")).map(([id, app]) => ({ key: id, title: app.root.querySelector(".desktop-app-titlebar span")?.textContent || id, z: Number(app.root.style.zIndex) || 0 }));
    const terminals = [...this.windowLayer.querySelectorAll<HTMLElement>(".terminal-window.open")].map((root) => ({ key: root.dataset.terminalId || root.id.replace(/^terminal-/, ""), title: root.dataset.terminalTitle || root.querySelector("header")?.textContent?.trim() || "Terminal", z: Number(root.style.zIndex) || 0 })).sort((a, b) => a.z - b.z);
    const activeApp = apps.sort((a, b) => a.z - b.z).at(-1);
    const activeTerminal = terminals.at(-1);
    const active = activeTerminal && (!activeApp || activeTerminal.z >= activeApp.z) ? activeTerminal : activeApp;
    const preview: DesktopPreview = { key: active?.key || "desktop", title: active?.title || "Desktop", terminal: !!activeTerminal && active === activeTerminal, snapshot: this.desktopSnapshot, snapshotId: this.desktopSnapshotSequence, desktopId: this.root.dataset.desktopPreviewId, videoRect: this.desktopVideoRect, videoClipRect: this.desktopVideoClipRect, videoVisibleRects: this.desktopVideoVisibleRects };
    this.onDesktopScreen(preview);
    this.scheduleDesktopSnapshot(preview);
  }

  private scheduleDesktopSnapshot(preview: DesktopPreview): void {
    this.desktopCapturePending = preview;
    if (this.desktopCaptureTimer || this.desktopCapturing) return;
    this.desktopCaptureTimer = window.setTimeout(() => { this.desktopCaptureTimer = 0; const pending = this.desktopCapturePending; this.desktopCapturePending = undefined; if (pending) void this.captureDesktopSnapshot(pending, ++this.desktopCaptureSequence); }, Math.max(0, 750 - (performance.now() - this.desktopCaptureAt)));
  }

  private async captureDesktopSnapshot(preview: DesktopPreview, sequence: number): Promise<void> {
    this.desktopCapturing = true;
    this.desktopCaptureAt = performance.now();
    this.rememberDesktopScroll();
    const captureRoot = this.root.cloneNode(true) as HTMLElement, captureId = `${this.root.dataset.desktopPreviewId}-${sequence}`;
    try {
      captureRoot.dataset.desktopCaptureId = captureId;
      captureRoot.classList.remove("open", "lid-closed");
      captureRoot.classList.add("screen-capturing");
      Object.assign(captureRoot.style, { position: "fixed", left: "0px", top: "0px", transform: "none", visibility: "visible", opacity: "0", pointerEvents: "none", zIndex: "-1", boxShadow: "none" });
      const sourceCanvases = this.root.querySelectorAll<HTMLCanvasElement>("canvas"), cloneCanvases = captureRoot.querySelectorAll<HTMLCanvasElement>("canvas");
      sourceCanvases.forEach((source, index) => { const clone = cloneCanvases[index]; if (clone) { clone.width = source.width; clone.height = source.height; clone.getContext("2d")?.drawImage(source, 0, 0); } });
      const sourceFields = this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"), cloneFields = captureRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select");
      sourceFields.forEach((source, index) => {
        const clone = cloneFields[index];
        if (!clone) return;
        if (source instanceof HTMLInputElement && clone instanceof HTMLInputElement) { if (source.type !== "file") clone.value = clone.defaultValue = source.value; clone.checked = clone.defaultChecked = source.checked; if (source.type === "radio" && source.name) clone.name = `${captureId}-${source.name}`; }
        else if (source instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) { clone.textContent = source.value; clone.value = source.value; }
        else if (source instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) { for (const [index, option] of Array.from(clone.options).entries()) option.selected = option.defaultSelected = source.options[index].selected; }
        clone.scrollTop = source.scrollTop; clone.scrollLeft = source.scrollLeft;
      });
      const sourceElements = this.root.querySelectorAll<HTMLElement>("*"), cloneElements = captureRoot.querySelectorAll<HTMLElement>("*");
      const scrollPositions = new Map<string, { left: number; top: number }>();
      document.body.appendChild(captureRoot);
      sourceElements.forEach((source, index) => { const clone = cloneElements[index], scroll = this.desktopScrollPositions.get(source) ?? { left: source.scrollLeft, top: source.scrollTop }; if (clone) { clone.scrollTop = scroll.top; clone.scrollLeft = scroll.left; if (clone.scrollTop || clone.scrollLeft) { const id = String(index); clone.dataset.desktopScrollIndex = id; scrollPositions.set(id, { left: clone.scrollLeft, top: clone.scrollTop }); } } });
      const body = captureRoot.querySelector<HTMLElement>(".desktop-body");
      if (!body) throw new Error("Desktop body is missing");
      const html2canvas = (await import("html2canvas")).default;
      const bounds = body.getBoundingClientRect();
      const videoSlot = captureRoot.querySelector<HTMLElement>(".desktop-app-window.open .youtube-video-slot:not([hidden])"), videoBounds = videoSlot?.getBoundingClientRect();
      let videoRect: DesktopPreview["videoRect"], videoClipRect: DesktopPreview["videoClipRect"], videoVisibleRects: DesktopPreview["videoVisibleRects"];
      if (videoSlot && videoBounds && videoBounds.width > 0 && videoBounds.height > 0 && getComputedStyle(videoSlot).visibility !== "hidden") {
        let left = Math.max(bounds.left, videoBounds.left), top = Math.max(bounds.top, videoBounds.top), right = Math.min(bounds.right, videoBounds.right), bottom = Math.min(bounds.bottom, videoBounds.bottom);
        for (const element of [videoSlot.closest<HTMLElement>(".desktop-app-content"), videoSlot.closest<HTMLElement>(".desktop-app-window")]) if (element) { const clip = element.getBoundingClientRect(); left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom); }
        if (right > left && bottom > top) {
          videoRect = { x: videoBounds.left - bounds.left, y: videoBounds.top - bounds.top, width: videoBounds.width, height: videoBounds.height }; videoClipRect = { x: left - bounds.left, y: top - bounds.top, width: right - left, height: bottom - top };
          const app = videoSlot.closest<HTMLElement>(".desktop-app-window")!, z = Number(getComputedStyle(app).zIndex) || 0, occluders: NonNullable<DesktopPreview["videoVisibleRects"]> = [];
          for (const window of captureRoot.querySelectorAll<HTMLElement>(".desktop-app-window.open,.terminal-window.open,.desktop-start-menu.open")) { if (window === app || !window.classList.contains("desktop-start-menu") && (Number(getComputedStyle(window).zIndex) || 0) <= z || getComputedStyle(window).visibility === "hidden") continue; const rectangle = window.getBoundingClientRect(); if (rectangle.width > 0 && rectangle.height > 0) occluders.push({ x: rectangle.left - bounds.left, y: rectangle.top - bounds.top, width: rectangle.width, height: rectangle.height }); }
          videoVisibleRects = subtractVideoOcclusion(videoClipRect, occluders);
        }
      }
      const width = Math.round(bounds.width || Math.min(window.innerWidth * 0.96, 1180));
      const height = Math.round(bounds.height || Math.max(1, Math.min(window.innerHeight * 0.88, 760) - 34));
      const snapshot = await html2canvas(body, {
        backgroundColor: null,
        height,
        logging: false,
        foreignObjectRendering: true,
        scale: 1,
        x: -bounds.left,
        y: -bounds.top,
        width,
        windowHeight: window.innerHeight,
        windowWidth: window.innerWidth,
        ignoreElements: (element) => element.parentElement === document.body && element !== captureRoot,
        onclone: (documentClone) => { const clone = documentClone.querySelector<HTMLElement>(`[data-desktop-capture-id="${captureId}"]`); if (!clone) throw new Error("Desktop capture root is missing"); clone.classList.remove("screen-capturing", "lid-closed"); clone.classList.add("open"); clone.style.visibility = "visible"; clone.style.opacity = "1"; clone.style.pointerEvents = "none"; clone.style.zIndex = "54"; clone.style.boxShadow = "none"; for (const element of clone.querySelectorAll<HTMLElement>("[data-desktop-scroll-index]")) { const scroll = scrollPositions.get(element.dataset.desktopScrollIndex!); if (!scroll) continue; element.scrollTop = element.scrollLeft = 0; element.style.overflow = "hidden"; for (const child of Array.from(element.children) as HTMLElement[]) child.style.transform = `translate(${-scroll.left}px,${-scroll.top}px) ${child.style.transform === "none" ? "" : child.style.transform}`; } }
      });
      this.desktopSnapshot = snapshot;
      this.desktopVideoRect = videoRect; this.desktopVideoClipRect = videoClipRect; this.desktopVideoVisibleRects = videoVisibleRects;
      this.desktopSnapshotSequence++;
      this.onDesktopScreen({ ...preview, snapshot, snapshotId: this.desktopSnapshotSequence, desktopId: this.root.dataset.desktopPreviewId, videoRect, videoClipRect, videoVisibleRects });
    } catch (problem) { console.error("Desktop screen capture failed", problem); } finally { captureRoot.remove(); this.desktopCapturing = false; if (this.desktopCapturePending) this.scheduleDesktopSnapshot(this.desktopCapturePending); }
  }

  setDesktopScreenHandler(handler: (preview: DesktopPreview) => void): void { this.onDesktopScreen = handler; this.refreshDesktopScreen(); }

  private rememberDesktopScroll(): void { if (this.root.isConnected && this.root.offsetWidth) for (const element of this.root.querySelectorAll<HTMLElement>("*")) this.desktopScrollPositions.set(element, { left: element.scrollLeft, top: element.scrollTop }); }

  private setLidOpen(open: boolean): void {
    this.lidOpen = open;
    if (this.mode === "worker" && this.workerSeat) this.office.setSeatLaptopOpen(this.workerSeat, open);
    else this.office.setBossLaptopOpen(open);
    this.root.classList.toggle("lid-closed", !open);
    const button = this.root.querySelector<HTMLButtonElement>("[data-lid]");
    if (button) { button.textContent = open ? "Close lid" : "Open lid"; button.setAttribute("aria-label", `${open ? "Close" : "Open"} laptop lid`); }
  }

  setHireAction(action: (container?: HTMLElement) => void): void { this.hireWorker = action; }

  async open(): Promise<void> {
    if (!this.root.isConnected) document.body.appendChild(this.root);
    this.root.querySelector(".pc-titlebar span")!.textContent = this.mode === "owner" ? "Office PC" : `${this.workerTerminal?.title ?? "Agent"} — Desktop`;
    this.setLidOpen(true);
    this.root.classList.add("open");
    for (const element of this.root.querySelectorAll<HTMLElement>("*")) { const scroll = this.desktopScrollPositions.get(element); if (scroll) { element.scrollTop = scroll.top; element.scrollLeft = scroll.left; } }
    document.body.classList.add("boss-computer-open");
    this.refreshDesktopScreen();
    document.body.classList.toggle("terminal-open", !!this.windowLayer.querySelector(".terminal-window.open"));
    try {
      const [profiles, options] = await Promise.all([
        this.api.request<AgentProfile[]>("detect_agent_profiles"),
        this.api.request<{ default: string }>("workspace_options")
      ]);
      this.profiles = profiles;
      this.cwd = this.workerTerminal?.cwd || options.default;
    } catch (problem) { this.error(problem instanceof Error ? problem.message : String(problem)); }
  }

  close(): void {
    this.rememberDesktopScroll();
    this.root.classList.remove("open");
    document.body.classList.remove("boss-computer-open");
    document.body.classList.remove("terminal-open");
    this.onLeave();
    this.root.remove();
    if (this.mode === "worker") this.onWorkerClose();
  }

  detachRoot(): void { if (!this.isOpen) this.root.remove(); }

  setState(state: OfficeState): void {
    this.state = { ...this.state, ...state, blindStages: state.blindStages ?? {}, season: state.season ?? "auto", wallArt: state.wallArt ?? [] };
    const controls = this.appWindows.get("controls");
    if (this.isOpen && controls?.root.classList.contains("open")) {
      const z = controls.root.style.zIndex;
      this.showControls();
      controls.root.style.zIndex = z;
    }
    const wallArt = this.appWindows.get("wall-art");
    if (this.isOpen && wallArt?.root.classList.contains("open")) { const z = wallArt.root.style.zIndex; this.showWallArt(); wallArt.root.style.zIndex = z; }
  }

  setHangPictureHandler(handler: () => void): void { this.onHangPicture = handler; }

  refreshSessions(): void { if (this.isOpen && this.appWindows.get("sessions")?.root.classList.contains("open")) void this.showSessions(); }

  private openAppWindow(id: string, title: string): HTMLElement {
    let app = this.appWindows.get(id);
    if (!app) {
      const root = document.createElement("section");
      root.className = "desktop-app-window";
      root.style.cssText = `position:absolute;left:${236 + this.appWindows.size * 24}px;top:${42 + this.appWindows.size * 24}px;width:min(620px,calc(100% - 250px));height:min(480px,calc(100% - 62px));min-width:320px;min-height:220px;display:none;flex-direction:column;overflow:hidden;border:1px solid #778493;border-radius:7px;background:#f3f5f7;color:#1d2732;box-shadow:0 12px 32px #06101b66;resize:both;pointer-events:auto`;
      const bar = document.createElement("header");
      bar.className = "desktop-app-titlebar";
      const label = document.createElement("span");
      label.textContent = title;
      const controls = document.createElement("div");
      controls.className = "desktop-app-window-controls";
      const control = (action: string, glyph: string, aria: string, click: () => void) => { const button = document.createElement("button"); button.dataset.action = action; button.textContent = glyph; button.setAttribute("aria-label", aria); button.title = aria; button.addEventListener("click", click); controls.appendChild(button); return button; };
      if (id === "youtube") { const cast = control("cast", this.youtubeCastActive ? "Cast off" : "Cast", this.youtubeCastActive ? "Stop casting" : "Cast to Office TV", () => this.youtubeCastAction()); cast.disabled = !this.youtubePlaying; cast.classList.toggle("casting", this.youtubeCastActive); }
      control("minimize", "−", `Minimize ${title}`, () => this.minimizeAppWindow(id));
      control("maximize", "□", `Maximize ${title}`, () => this.toggleAppWindowMaximize(id));
      control("close", "×", `Close ${title}`, () => this.closeAppWindow(id));
      bar.append(label, controls);
      const content = document.createElement("div");
      content.className = "desktop-app-content";
      content.style.cssText = "flex:1;min-height:0;overflow:auto;padding:14px 18px;color:#1d2732;background:#f3f5f7";
      root.append(bar, content);
      root.addEventListener("pointerdown", () => { root.style.zIndex = String(++this.appWindowZ); });
      bar.addEventListener("dblclick", (event) => { if (!(event.target as HTMLElement).closest("button")) this.toggleAppWindowMaximize(id); });
      let drag: { x: number; y: number } | null = null;
      bar.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        const bounds = root.getBoundingClientRect();
        drag = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        bar.setPointerCapture(event.pointerId);
        root.style.zIndex = String(++this.appWindowZ);
      });
      bar.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const bounds = this.windowLayer.getBoundingClientRect();
        root.style.left = `${Math.max(0, Math.min(bounds.width - root.offsetWidth, event.clientX - bounds.left - drag.x))}px`;
        root.style.top = `${Math.max(0, Math.min(bounds.height - 38, event.clientY - bounds.top - drag.y))}px`;
      });
      const stop = () => { drag = null; };
      bar.addEventListener("pointerup", stop);
      bar.addEventListener("pointercancel", stop);
      this.windowLayer.appendChild(root);
      const taskbar = document.createElement("button");
      taskbar.className = "desktop-window-task";
      taskbar.textContent = title;
      taskbar.title = title;
      taskbar.hidden = true;
      taskbar.addEventListener("click", () => app?.root.classList.contains("open") ? this.minimizeAppWindow(id) : this.restoreAppWindow(id));
      this.root.querySelector(".desktop-pinned")!.appendChild(taskbar);
      app = { root, content, taskbar, maximized: false };
      this.appWindows.set(id, app);
    }
    app.root.style.display = "flex";
    app.root.style.zIndex = String(++this.appWindowZ);
    app.root.classList.add("open");
    app.root.classList.remove("minimized");
    app.taskbar.hidden = false;
    app.taskbar.classList.add("active");
    this.workspace = app.content;
    return app.content;
  }

  private closeAppWindow(id: string): void {
    const app = this.appWindows.get(id);
    if (app) { app.root.classList.remove("open", "minimized", "maximized"); app.root.style.display = "none"; app.taskbar.hidden = true; app.taskbar.classList.remove("active"); app.maximized = false; }
  }

  private minimizeAppWindow(id: string): void {
    const app = this.appWindows.get(id);
    if (!app) return;
    app.root.classList.remove("open");
    app.root.classList.add("minimized");
    app.root.style.display = "none";
    app.taskbar.classList.remove("active");
  }

  private restoreAppWindow(id: string): void {
    const app = this.appWindows.get(id);
    if (!app) return;
    app.root.style.display = "flex";
    app.root.classList.remove("minimized");
    app.root.classList.add("open");
    app.root.style.zIndex = String(++this.appWindowZ);
    app.taskbar.hidden = false;
    app.taskbar.classList.add("active");
    this.workspace = app.content;
  }

  private toggleAppWindowMaximize(id: string): void {
    const app = this.appWindows.get(id);
    if (!app) return;
    app.maximized = !app.maximized;
    app.root.classList.toggle("maximized", app.maximized);
    const button = app.root.querySelector<HTMLButtonElement>('[data-action="maximize"]');
    if (button) { button.textContent = app.maximized ? "❐" : "□"; button.setAttribute("aria-label", `${app.maximized ? "Restore" : "Maximize"} ${id}`); }
    app.root.style.zIndex = String(++this.appWindowZ);
  }

  private async launch(id: string): Promise<void> {
    const profile = this.profiles.find((entry) => entry.id === id);
    if (!profile) return this.error(`${id === "windows-cmd" ? "Command Prompt" : "PowerShell"} is unavailable`);
    try {
      const seat = this.workerSeat ?? this.office.bossSeat;
      const terminal = await this.api.request<Terminal>("spawn_terminal", { request: {
        label: profile.name, profileId: "boss-shell", command: profile.command, args: profile.args || [], cwd: this.cwd,
        env: this.mode === "worker" && this.workerTerminal ? { AGENTOFFICE_PARENT_TERMINAL: this.workerTerminal.id } : {}, role: "Runner", accent: profile.accent, swarmX: seat.x, swarmY: seat.z,
        cols: 100, rows: 28
      } });
      this.openTerminal(terminal, this.windowLayer);
    this.refreshDesktopScreen();
    } catch (problem) { this.error(problem instanceof Error ? problem.message : String(problem)); }
  }

  private openWorkerSession(): void { if (this.workerTerminal) { this.openTerminal(this.workerTerminal, this.windowLayer); this.refreshDesktopScreen(); } }

  private async showSessions(): Promise<void> {
    const [active, saved] = await Promise.all([
      this.api.request<Terminal[]>("list_terminals"),
      this.api.request<Terminal[]>("list_saved_terminal_deck")
    ]);
    const belongsToDesktop = (terminal: Terminal) => this.mode === "owner" || (!!this.workerSeat && typeof terminal.swarmX === "number" && typeof terminal.swarmY === "number" && Math.abs(terminal.swarmX - this.workerSeat.x) < 0.08 && Math.abs(terminal.swarmY - this.workerSeat.z) < 0.08);
    const running = active.filter((terminal) => terminal.profileId === "boss-shell" && belongsToDesktop(terminal) && (terminal.state === "running" || terminal.state === "launching"));
    const activeIds = new Set(running.map((terminal) => terminal.id));
    const paused = saved.filter((terminal) => terminal.profileId === "boss-shell" && belongsToDesktop(terminal) && !activeIds.has(terminal.id));
    const workspace = this.openAppWindow("sessions", "Sessions");
    workspace.replaceChildren();
    if (!running.length && !paused.length) {
      const empty = document.createElement("p");
      empty.textContent = "No terminal sessions yet.";
      workspace.appendChild(empty);
    }
    for (const terminal of [...running, ...paused]) {
      const row = document.createElement("div");
      row.className = "desktop-session";
      const name = document.createElement("span");
      name.textContent = `${terminal.title} · ${terminal.cwd}`;
      const button = document.createElement("button");
      const isRunning = activeIds.has(terminal.id);
      button.textContent = isRunning ? "Open" : "Resume";
      button.addEventListener("click", async () => {
        try {
          const selected = isRunning ? terminal : await this.api.request<Terminal>("resume_terminal", { id: terminal.id });
          this.openTerminal(selected, this.windowLayer);
        } catch (problem) { this.error(problem instanceof Error ? problem.message : String(problem)); }
      });
      const end = document.createElement("button");
      end.className = "danger";
      end.textContent = "End";
      end.title = `End ${terminal.title} and remove its saved session`;
      end.addEventListener("click", async () => {
        end.disabled = true;
        try {
          await this.api.request("remove_terminal", { id: terminal.id });
          await this.showSessions();
        } catch (problem) {
          end.disabled = false;
          this.error(problem instanceof Error ? problem.message : String(problem));
        }
      });
      row.append(name, button, end);
      workspace.appendChild(row);
    }
  }

  private async showMusic(): Promise<void> {
    const workspace = this.openAppWindow("music", "Music");
    workspace.replaceChildren();
    const local = document.createElement("section");
    local.className = "desktop-music-section";
    const localTitle = document.createElement("strong");
    localTitle.textContent = "Local music";
    const folder = document.createElement("input");
    folder.className = "desktop-music-path";
    folder.placeholder = "Folder path on this computer";
    folder.setAttribute("aria-label", "Music folder");
    const browse = document.createElement("button");
    browse.textContent = "Browse";
    browse.setAttribute("aria-label", "Browse for a music folder");
    const folderPicker = document.createElement("input");
    folderPicker.type = "file";
    folderPicker.multiple = true;
    folderPicker.hidden = true;
    folderPicker.setAttribute("webkitdirectory", "");
    const scan = document.createElement("button");
    scan.textContent = "Scan folder";
    const status = document.createElement("span");
    status.className = "desktop-music-status";
    const list = document.createElement("div");
    list.className = "desktop-music-list";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.className = "desktop-music-audio";
    local.append(localTitle, folder, browse, folderPicker, scan, status, list, audio);
    workspace.appendChild(local);
    const online = document.createElement("section");
    online.className = "desktop-music-section";
    const onlineTitle = document.createElement("strong");
    onlineTitle.textContent = "YouTube";
    const youtubeUrl = document.createElement("input");
    youtubeUrl.className = "desktop-music-path";
    youtubeUrl.placeholder = "Paste a YouTube link";
    youtubeUrl.setAttribute("aria-label", "YouTube link");
    const playVideo = document.createElement("button");
    playVideo.textContent = "Play";
    const streamTV = document.createElement("button");
    streamTV.textContent = "Play on TV";
    const stopVideo = document.createElement("button");
    stopVideo.textContent = "Stop video";
    const videoStatus = document.createElement("span");
    videoStatus.className = "desktop-music-status";
    const videoSlot = document.createElement("div");
    videoSlot.className = "desktop-music-video";
    videoSlot.hidden = true;
    online.append(onlineTitle, youtubeUrl, playVideo, streamTV, stopVideo, videoStatus, videoSlot);
    workspace.appendChild(online);
    let selectedFiles: File[] = [], objectURLs: string[] = [];
    browse.addEventListener("click", () => folderPicker.click());
    folderPicker.addEventListener("change", () => {
      selectedFiles = Array.from(folderPicker.files ?? []);
      folder.value = folderPicker.files?.[0]?.webkitRelativePath.split("/")[0] ?? "";
      status.textContent = selectedFiles.length ? `${selectedFiles.length} files selected` : "";
    });
    scan.addEventListener("click", async () => {
      scan.disabled = true;
      status.textContent = "Scanning…";
      try {
        list.replaceChildren();
        audio.pause();
        objectURLs.forEach(URL.revokeObjectURL);
        objectURLs = [];
        const files = selectedFiles.filter((file) => /\.(aac|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(file.name));
        const tracks: { name: string; url: string }[] = files.map((file) => {
          const url = URL.createObjectURL(file);
          objectURLs.push(url);
          return { name: file.webkitRelativePath || file.name, url };
        });
        if (!selectedFiles.length && folder.value.trim()) {
          const remoteTracks = await this.api.request<MusicTrack[]>("scan_music", { path: folder.value.trim() });
          tracks.push(...remoteTracks.map((track) => ({ name: track.name, url: `/music/${encodeURIComponent(track.id)}` })));
        }
        status.textContent = tracks.length ? `${tracks.length} tracks` : "No supported audio files found.";
        for (const track of tracks) {
          const button = document.createElement("button");
          button.textContent = track.name;
          button.addEventListener("click", () => {
            this.stopYouTube();
            this.youtubePlaying = false; this.setYouTubeCasting(false);
            videoSlot.hidden = true;
            audio.src = track.url;
            void audio.play().catch((problem) => { status.textContent = problem instanceof Error ? problem.message : String(problem); });
          });
          list.appendChild(button);
        }
      } catch (problem) { status.textContent = problem instanceof Error ? problem.message : String(problem); }
      scan.disabled = false;
    });
    const startYouTube = (target?: YouTubeTarget) => {
      const id = youtubeVideoId(youtubeUrl.value);
      if (!id) { this.stopYouTube(); this.youtubePlaying = false; this.setYouTubeCasting(false); videoSlot.hidden = true; videoStatus.textContent = "Use a YouTube link with an 11-character video ID."; return; }
      audio.pause();
      this.youtubePlaying = true; this.setYouTubeCasting(false); videoSlot.hidden = target === "tv";
      this.playYouTube(id, videoSlot);
      if (target === "tv") this.setYouTubeCasting(true);
      videoStatus.textContent = target === "tv" ? "Playing on TV." : "Playing.";
    };
    playVideo.addEventListener("click", () => startYouTube());
    streamTV.addEventListener("click", () => startYouTube("tv"));
    stopVideo.addEventListener("click", () => { this.stopYouTube(); this.youtubePlaying = false; this.setYouTubeCasting(false); videoSlot.hidden = true; videoStatus.textContent = "Playback stopped."; });
  }

  private showYouTube(): void {
    const workspace = this.openAppWindow("youtube", "YouTube");
    workspace.replaceChildren();
    const section = document.createElement("section"); section.className = "youtube-watch-app";
    const header = document.createElement("div"); header.className = "youtube-watch-header";
    const brand = document.createElement("div"); brand.className = "youtube-brand"; brand.innerHTML = '<span aria-label="YouTube">▶</span>';
    const url = document.createElement("input");
    url.className = "youtube-search-input";
    url.placeholder = "Paste a YouTube video link";
    url.setAttribute("aria-label", "YouTube link");
    const play = document.createElement("button");
    play.className = "youtube-search-button"; play.textContent = "▶"; play.setAttribute("aria-label", "Play video");
    const search = document.createElement("div"); search.className = "youtube-search-box"; search.append(url, play); header.append(brand, search);
    const slot = document.createElement("div"); slot.className = "desktop-music-video youtube-video-slot"; slot.hidden = true;
    const empty = document.createElement("div"); empty.className = "youtube-empty-player"; empty.innerHTML = '<span class="youtube-empty-logo">▶</span><strong>Your video will appear here</strong><span>Paste a YouTube link above to start watching.</span>';
    const videoTitle = document.createElement("h2"); videoTitle.className = "youtube-video-title"; videoTitle.textContent = "Watch";
    const videoActions = document.createElement("div"); videoActions.className = "youtube-watch-actions";
    const stop = document.createElement("button");
    stop.className = "youtube-stop-button"; stop.textContent = "Stop playback";
    const status = document.createElement("span");
    status.className = "youtube-playback-status"; status.setAttribute("role", "status");
    videoActions.append(videoTitle, stop); section.append(header, slot, empty, videoActions, status);
    workspace.appendChild(section);
    const castButton = this.appWindows.get("youtube")?.root.querySelector<HTMLButtonElement>('[data-action="cast"]');
    if (castButton) castButton.disabled = !this.youtubePlaying;
    slot.addEventListener("youtube-player-state", (event) => this.syncYouTubePlayback((event as CustomEvent<YouTubePlayback>).detail));
    const startYouTube = () => {
      const id = youtubeVideoId(url.value);
      if (!id) { this.stopYouTube(); status.textContent = "Paste a link with an 11-character YouTube video ID."; return; }
      this.playYouTube(id, slot);
    };
    this.youtubeCastAction = () => {
      if (!this.youtubePlaying) { status.textContent = "Play a video before casting."; return; }
      this.setYouTubeCasting(!this.youtubeCastActive);
    };
    play.addEventListener("click", startYouTube);
    url.addEventListener("keydown", (event) => { if (event.key === "Enter") startYouTube(); });
    stop.addEventListener("click", () => this.stopYouTube());
    if (this.youtubePlayback) { this.youtubePlaybackSignature = ""; this.syncYouTubePlayback(this.youtubePlayback); }
    this.attachYouTubeSlot(slot);
  }

  private showSettings(): void {
    const workspace = this.openAppWindow("settings", "Settings");
    workspace.replaceChildren();
    const layout = document.createElement("div");
    layout.style.cssText = "display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;min-height:100%;min-width:0";
    const nav = document.createElement("nav");
    nav.style.cssText = "display:grid;align-content:start;gap:5px;padding-right:10px;border-right:1px solid #c9d1d8";
    const page = document.createElement("main");
    page.style.cssText = "min-width:0;padding:4px 2px";
    const home = document.createElement("button"); home.textContent = "Settings home";
    const personalization = document.createElement("button"); personalization.textContent = "Personalization";
    for (const button of [home, personalization]) button.style.cssText = "padding:8px 9px;border:0;border-radius:5px;background:transparent;text-align:left;color:#263544;font:13px system-ui,sans-serif";
    const showHome = () => {
      home.classList.add("selected"); personalization.classList.remove("selected"); home.style.background = "#e0e9ef"; personalization.style.background = "transparent"; page.replaceChildren();
      const card = document.createElement("button"); card.style.cssText = "display:grid;gap:5px;width:min(360px,100%);padding:14px;border:1px solid #c5cdd4;border-radius:7px;background:#fff;text-align:left;color:#263544";
      const name = document.createElement("strong"); name.textContent = "Personalization";
      const detail = document.createElement("span"); detail.textContent = this.mode === "owner" ? "Change the desktop background and laptop icon." : "Change the desktop background.";
      card.append(name, detail); card.addEventListener("click", () => showPersonalization());
      page.append(card);
    };
    const showPersonalization = () => { home.classList.remove("selected"); personalization.classList.add("selected"); home.style.background = "transparent"; personalization.style.background = "#e0e9ef"; this.showPersonalization(page); };
    home.addEventListener("click", showHome);
    personalization.addEventListener("click", showPersonalization);
    nav.append(home, personalization); layout.append(nav, page); workspace.appendChild(layout); showHome();
  }

  private showPersonalization(workspace = this.openAppWindow("settings", "Settings")): void {
    workspace.replaceChildren();
    const pageTitle = document.createElement("h2"); pageTitle.textContent = "Personalization"; pageTitle.style.cssText = "margin:0 0 14px;font:600 19px system-ui,sans-serif";
    workspace.appendChild(pageTitle);
    this.showDesktopBackground(workspace);
    if (this.mode !== "owner") return;
    const section = document.createElement("section");
    section.className = "desktop-music-section";
    const title = document.createElement("strong");
    title.textContent = "Laptop icon";
    const icon = document.createElement("select");
    icon.setAttribute("aria-label", "Boss laptop icon");
    for (const optionData of modelIconOptions) { const option = document.createElement("option"); option.value = optionData.id; option.textContent = optionData.label; icon.appendChild(option); }
    const customOption = document.createElement("option");
    customOption.value = "custom";
    customOption.textContent = "Custom image";
    icon.appendChild(customOption);
    const upload = document.createElement("input");
    upload.type = "file";
    upload.accept = "image/png,image/jpeg,image/webp";
    upload.setAttribute("aria-label", "Upload a custom laptop icon");
    const preview = document.createElement("img");
    preview.alt = "Laptop icon preview";
    preview.style.cssText = "width:44px;height:44px;object-fit:contain;grid-column:1/-1";
    const status = document.createElement("span");
    status.className = "desktop-music-status";
    const save = document.createElement("button");
    save.textContent = "Apply icon";
    let customIcon = localStorage.getItem(OWNER_LAPTOP_ICON_KEY) ?? "";
    const current = () => icon.value === "custom" ? customIcon : modelIconPath(icon.value);
    const showPreview = () => { const value = current(); if (value) { preview.src = value; preview.hidden = false; } else { preview.removeAttribute("src"); preview.hidden = true; } };
    if (isCustomLaptopIcon(customIcon)) icon.value = "custom";
    else icon.value = customIcon;
    showPreview();
    icon.addEventListener("change", () => { if (icon.value !== "custom") customIcon = ""; showPreview(); });
    upload.addEventListener("change", () => {
      const file = upload.files?.[0];
      if (!file) return;
      void readCustomLaptopIcon(file).then((value) => { customIcon = value; icon.value = "custom"; status.textContent = "Custom icon ready."; showPreview(); }).catch((problem) => { status.textContent = problem instanceof Error ? problem.message : String(problem); });
    });
    save.addEventListener("click", () => {
      if (icon.value === "custom" && !customIcon) { status.textContent = "Choose a custom image first."; return; }
      const value = current();
      localStorage.setItem(OWNER_LAPTOP_ICON_KEY, icon.value === "custom" ? customIcon : icon.value);
      this.office.setLaptopIcon(this.office.bossLaptop, value, "#e8a27f");
      status.textContent = "Laptop icon updated.";
    });
    section.append(title, icon, upload, preview, save, status);
    workspace.appendChild(section);
  }

  private desktopWallpaperKey(): string { return this.mode === "owner" ? "agent-office-owner-desktop-wallpaper" : `agent-office-worker-desktop-wallpaper-${this.workerTerminal?.id ?? "default"}`; }

  private loadDesktopWallpaper(): DesktopWallpaper {
    try { const value = JSON.parse(localStorage.getItem(this.desktopWallpaperKey()) ?? "{}"); return { color: /^#[\da-f]{6}$/i.test(value.color) ? value.color : undefined, image: typeof value.image === "string" && value.image.startsWith("data:image/") ? value.image : undefined }; } catch { return {}; }
  }

  private applyDesktopWallpaper(value = this.loadDesktopWallpaper()): void {
    const wallpaper = this.root.querySelector<HTMLElement>(".desktop-wallpaper");
    if (!wallpaper) return;
    wallpaper.dataset.wallpaperKind = value.image ? "image" : value.color ? "color" : "default";
    wallpaper.style.backgroundColor = value.color ?? "";
    wallpaper.style.backgroundImage = value.image ? `linear-gradient(0deg,#07111f55,#07111f22),url("${value.image}")` : value.color ? "none" : "";
    wallpaper.style.backgroundPosition = "center"; wallpaper.style.backgroundSize = value.image ? "cover" : "";
  }

  private showDesktopBackground(workspace: HTMLElement): void {
    const section = document.createElement("section"); section.className = "desktop-music-section desktop-background-settings";
    const title = document.createElement("strong"); title.textContent = "Desktop background";
    const colorLabel = document.createElement("label"); colorLabel.textContent = "Color";
    const color = document.createElement("input"); color.type = "color"; color.setAttribute("aria-label", "Desktop background color");
    const imageLabel = document.createElement("label"); imageLabel.textContent = "Wallpaper image";
    const image = document.createElement("input"); image.type = "file"; image.accept = "image/png,image/jpeg,image/webp"; image.setAttribute("aria-label", "Upload desktop wallpaper");
    const preview = document.createElement("div"); preview.className = "desktop-background-preview";
    const reset = document.createElement("button"); reset.textContent = "Reset background";
    const status = document.createElement("span"); status.className = "desktop-music-status";
    let value = this.loadDesktopWallpaper(); color.value = value.color ?? "#315d76";
    const previewValue = () => { preview.style.backgroundColor = value.color ?? "#142f46"; preview.style.backgroundImage = value.image ? `linear-gradient(0deg,#07111f55,#07111f22),url("${value.image}")` : ""; };
    const save = () => { try { localStorage.setItem(this.desktopWallpaperKey(), JSON.stringify(value)); this.applyDesktopWallpaper(value); previewValue(); status.textContent = "Background saved for this desktop."; } catch { status.textContent = "Could not save this background. Try a smaller image."; } };
    color.addEventListener("input", () => { value.color = color.value; save(); });
    image.addEventListener("change", () => {
      const file = image.files?.[0]; if (!file) return;
      status.textContent = "Preparing wallpaper…";
      void readDesktopWallpaper(file).then((data) => { value.image = data; save(); }).catch((problem) => { status.textContent = problem instanceof Error ? problem.message : String(problem); });
    });
    reset.addEventListener("click", () => { value = {}; try { localStorage.removeItem(this.desktopWallpaperKey()); this.applyDesktopWallpaper(value); previewValue(); status.textContent = "Default background restored."; } catch { status.textContent = "Could not reset this background."; } });
    previewValue(); section.append(title, colorLabel, color, imageLabel, image, preview, reset, status); workspace.appendChild(section);
  }

  private showGames(): void {
    const workspace = this.openAppWindow("games", "Games");
    workspace.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = "Tic-Tac-Toe";
    const status = document.createElement("p");
    status.className = "tic-tac-toe-status";
    const board = document.createElement("div");
    board.className = "tic-tac-toe-board";
    const reset = document.createElement("button");
    reset.textContent = "New game";
    const cells: ("X" | "O" | null)[] = Array(9).fill(null);
    const wins = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
    const winner = (state: ("X" | "O" | null)[]) => wins.map((line) => line.every((i) => state[i] === state[line[0]]) && state[line[0]] ? state[line[0]] : null).find(Boolean) ?? null;
    let finished = false;
    const evaluate = (state: ("X" | "O" | null)[], turn: "X" | "O", depth: number): number => {
      const result = winner(state);
      if (result === "X") return 10 - depth;
      if (result === "O") return depth - 10;
      if (state.every(Boolean)) return 0;
      let best = turn === "X" ? -Infinity : Infinity;
      for (let i = 0; i < state.length; i++) if (!state[i]) { state[i] = turn; const value = evaluate(state, turn === "X" ? "O" : "X", depth + 1); state[i] = null; best = turn === "X" ? Math.max(best, value) : Math.min(best, value); }
      return best;
    };
    const render = () => {
      board.replaceChildren();
      for (let i = 0; i < cells.length; i++) {
        const square = document.createElement("button");
        square.className = "tic-tac-toe-square";
        square.textContent = cells[i] ?? "";
        square.setAttribute("aria-label", `Square ${i + 1}${cells[i] ? ` ${cells[i]}` : " empty"}`);
        square.disabled = finished || !!cells[i];
        square.addEventListener("click", () => {
          if (finished || cells[i]) return;
          cells[i] = "X";
          let result = winner(cells);
          if (result || cells.every(Boolean)) { finished = true; status.textContent = result ? `${result === "X" ? "You win" : "Computer wins"}` : "Draw"; render(); return; }
          let move = -1, best = Infinity;
          for (let j = 0; j < cells.length; j++) if (!cells[j]) { cells[j] = "O"; const value = evaluate(cells, "X", 0); cells[j] = null; if (value < best) { best = value; move = j; } }
          if (move >= 0) cells[move] = "O";
          result = winner(cells);
          if (result || cells.every(Boolean)) { finished = true; status.textContent = result ? "Computer wins" : "Draw"; }
          else status.textContent = "Your turn — X";
          render();
        });
        board.appendChild(square);
      }
    };
    reset.addEventListener("click", () => { cells.fill(null); finished = false; status.textContent = "Your turn — X"; render(); });
    status.textContent = "Your turn — X";
    workspace.append(title, status, board, reset);
    render();
  }

  private showWallArt(): void {
    const workspace = this.openAppWindow("wall-art", "Paintings");
    workspace.replaceChildren();
    const hang = document.createElement("button"); hang.textContent = "Hang a picture"; hang.addEventListener("click", () => { this.close(); this.onHangPicture(); });
    const list = document.createElement("div"); list.className = "desktop-control-list";
    for (const item of this.state.wallArt ?? []) {
      const row = document.createElement("div"); row.className = "desktop-control";
      const title = document.createElement("strong"); title.textContent = item.title || "Wall picture";
      const remove = document.createElement("button"); remove.textContent = "Take down"; remove.addEventListener("click", () => void this.setControl({ wallArt: this.state.wallArt.filter((art) => art.id !== item.id) }));
      row.append(title, remove); list.appendChild(row);
    }
    workspace.append(hang, list);
  }

  private showControls(): void {
    const workspace = this.openAppWindow("controls", "Office controls");
    workspace.replaceChildren();
    const officeHours = document.createElement("button");
    officeHours.textContent = this.state.officeClosed ? "Open office for the day" : "Close office for the day";
    officeHours.addEventListener("click", () => void this.setControl({ officeClosed: !this.state.officeClosed }));
    workspace.appendChild(officeHours);
    const row = (label: string) => {
      const group = document.createElement("div");
      group.className = "desktop-control";
      const name = document.createElement("strong");
      name.textContent = label;
      group.appendChild(name);
      workspace.appendChild(group);
      return group;
    };
    for (const [label, field] of [["Office", "lightsOn"], ["Break room", "breakroomOn"]] as [string, "lightsOn" | "breakroomOn"][]) {
      const lights = row(label);
      for (const [option, on] of [["On", true], ["Off", false]] as [string, boolean][]) {
        const button = document.createElement("button");
        button.textContent = option;
        button.classList.toggle("selected", this.state[field] === on);
        button.addEventListener("click", () => void this.setControl({ [field]: on }));
        lights.appendChild(button);
      }
    }
    for (let i = 0; i < this.state.lightRows.length; i++) {
      const group = row(`Office light row ${i + 1}`);
      for (const [option, on] of [["On", true], ["Off", false]] as [string, boolean][]) {
        const button = document.createElement("button");
        button.textContent = option;
        button.classList.toggle("selected", this.state.lightRows[i] === on);
        button.addEventListener("click", () => {
          const lightRows = [...this.state.lightRows] as [boolean, boolean, boolean];
          lightRows[i] = on;
          void this.setControl({ lightRows });
        });
        group.appendChild(button);
      }
    }
    const blinds = row("Roller blinds");
    blinds.classList.add("desktop-blinds-control");
    const blindGrid = document.createElement("div");
    blindGrid.className = "desktop-blinds-grid";
    blinds.appendChild(blindGrid);
    const blindActions = document.createElement("div"); blindActions.className = "desktop-blind-actions";
    const openBlinds = document.createElement("button"); openBlinds.textContent = "Open all"; openBlinds.addEventListener("click", () => void this.setControl({ blindStage: 0 }));
    const closeBlinds = document.createElement("button"); closeBlinds.textContent = "Close all"; closeBlinds.addEventListener("click", () => void this.setControl({ blindStage: 2 }));
    blindActions.append(openBlinds, closeBlinds); blindGrid.appendChild(blindActions);
    for (const control of this.office.blindControls) {
      const group = document.createElement("div"); group.className = "desktop-blind-control";
      const label = document.createElement("strong"); label.textContent = control.label;
      const select = document.createElement("select"); select.setAttribute("aria-label", control.label);
      for (const [value, text] of [[0, "Open"], [1, "Half"], [2, "Closed"]] as [number, string][]) { const option = document.createElement("option"); option.value = String(value); option.textContent = text; select.appendChild(option); }
      select.value = String(this.state.blindStages?.[control.id] ?? this.state.blindStage);
      select.addEventListener("change", () => { const blindStages = Object.fromEntries(this.office.blindControls.map((item) => [item.id, this.office.blindStages[item.id] ?? this.state.blindStage])), stage = Number(select.value); blindStages[control.id] = stage; void this.setControl({ blindStage: stage, blindStages }); });
      group.append(label, select); blindGrid.appendChild(group);
    }
    const season = row("Seasonal weather");
    const seasonSelect = document.createElement("select"); seasonSelect.setAttribute("aria-label", "Seasonal weather");
    for (const [value, label] of [["auto", "Automatic"], ["spring", "Spring"], ["summer", "Summer"], ["autumn", "Autumn"], ["winter", "Winter"]] as [SeasonOption, string][]) { const option = document.createElement("option"); option.value = value; option.textContent = label; seasonSelect.appendChild(option); }
    seasonSelect.value = this.state.season ?? "auto"; seasonSelect.addEventListener("change", () => void this.setControl({ season: seasonSelect.value as SeasonOption }));
    season.appendChild(seasonSelect);
  }

  private async setControl(change: Partial<OfficeState>): Promise<void> {
    try {
      this.rememberBlindStages(change);
      const state = await this.api.request<OfficeState>("office_state_set", change);
      this.setState(change.blindStages && !Object.keys(state.blindStages ?? {}).length ? { ...state, blindStages: { ...this.state.blindStages, ...change.blindStages } } : state);
      if (typeof change.officeClosed === "boolean") this.onOfficeClosed(change.officeClosed);
    } catch (problem) {
      if (typeof change.officeClosed === "boolean") {
        this.setState({ ...this.state, officeClosed: change.officeClosed });
        this.onOfficeClosed(change.officeClosed);
        return;
      }
      this.error(problem instanceof Error ? problem.message : String(problem));
    }
  }
}
