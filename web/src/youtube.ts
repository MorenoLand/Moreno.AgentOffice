import * as THREE from "three";
import type { Office } from "./office";
import type { DesktopPreview } from "./terminal_screen";

export type YouTubeTarget = "auto" | "laptop" | "tv";
export interface YouTubePlayback { videoId: string; title: string; target: YouTubeTarget; state: number; ready: boolean; error: string; autoplayBlocked: boolean }
export function youtubeVideoId(value: string): string { const text = value.trim(); if (/^[a-zA-Z0-9_-]{11}$/.test(text)) return text; try { const url = new URL(text); if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0].match(/^[a-zA-Z0-9_-]{11}$/)?.[0] ?? ""; if (!/(^|\.)youtube\.com$/.test(url.hostname)) return ""; return (url.searchParams.get("v") ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] ?? "").match(/^[a-zA-Z0-9_-]{11}$/)?.[0] ?? ""; } catch { return ""; } }
export function subtractVideoOcclusion(rect: NonNullable<DesktopPreview["videoRect"]>, occluders: readonly NonNullable<DesktopPreview["videoRect"]>[]) {
  let regions = rect.width > 0 && rect.height > 0 ? [rect] : [];
  for (const cover of occluders) regions = regions.flatMap((area) => {
    const left = Math.max(area.x, cover.x), top = Math.max(area.y, cover.y), right = Math.min(area.x + area.width, cover.x + cover.width), bottom = Math.min(area.y + area.height, cover.y + cover.height);
    if (right <= left || bottom <= top) return [area];
    return [{ x: area.x, y: area.y, width: area.width, height: top - area.y }, { x: area.x, y: bottom, width: area.width, height: area.y + area.height - bottom }, { x: area.x, y: top, width: left - area.x, height: bottom - top }, { x: right, y: top, width: area.x + area.width - right, height: bottom - top }].filter((part) => part.width > 0 && part.height > 0);
  });
  return regions;
}
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;

export class YouTubeProjection {
  private readonly overlay = document.createElement("div");
  private readonly frame = document.createElement("iframe");
  private readonly tvCanvas = document.createElement("canvas");
  private readonly tvTexture = new THREE.CanvasTexture(this.tvCanvas);
  private readonly screenMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private readonly holeMaterial = new THREE.MeshBasicMaterial({ color: 0, opacity: 0, transparent: false, blending: THREE.NoBlending, depthWrite: true });
  private activeScreen?: THREE.Mesh;
  private laptopScreen: THREE.Mesh;
  private readonly desktopPreviews = new Map<string, { preview: DesktopPreview; screen: THREE.Mesh }>();
  private readonly laptopCutout = new THREE.Mesh(new THREE.BufferGeometry(), this.holeMaterial);
  private laptopCutoutSignature = "";
  private readonly laptopProjection = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  private readonly corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly center = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly listeners = new Set<(playback: Readonly<YouTubePlayback>) => void>();
  private playbackState: YouTubePlayback = { videoId: "", title: "", target: "auto", state: -1, ready: false, error: "", autoplayBlocked: false };
  private readyTimer = 0;
  private slot?: HTMLElement;
  private source: "phone" | "pc" = "pc";
  private active = false;
  private target: YouTubeTarget = "auto";

  constructor(private office: Office) {
    this.laptopScreen = office.bossLaptop.screen; this.laptopCutout.visible = this.laptopProjection.visible = false;
    this.laptopCutout.raycast = this.laptopProjection.raycast = () => {};
    this.laptopCutout.renderOrder = 1;
    this.overlay.style.cssText = "position:fixed;left:0;top:0;z-index:58;display:none;overflow:hidden;transform-origin:0 0;background:#05080a;pointer-events:none;";
    this.overlay.dataset.youtubeSurface = "";
    this.frame.title = "YouTube stream";
    this.frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    this.frame.allowFullscreen = true;
    this.frame.referrerPolicy = "no-referrer-when-downgrade";
    this.frame.style.cssText = "display:block;width:100%;height:100%;border:0;pointer-events:auto;";
    this.frame.addEventListener("load", () => { if (!this.active) return; this.frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: "office-youtube" }), "https://www.youtube.com"); for (const event of ["onReady", "onStateChange", "onError", "onAutoplayBlocked"]) this.command("addEventListener", [event]); });
    window.addEventListener("message", (event) => {
      if (event.source !== this.frame.contentWindow || event.origin !== "https://www.youtube.com") return;
      try {
        const message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (message?.event === "onReady") { this.playbackState.ready = true; window.clearTimeout(this.readyTimer); this.emit(); }
        if (message?.event === "onStateChange" && Number.isInteger(message.info)) { this.playbackState.state = message.info; this.playbackState.ready = true; this.playbackState.error = ""; this.playbackState.autoplayBlocked = false; window.clearTimeout(this.readyTimer); this.emit(); }
        if (message?.event === "onAutoplayBlocked") { this.playbackState.autoplayBlocked = true; this.emit(); }
        if (message?.event === "infoDelivery") { const info = message.info; if (typeof info?.videoData?.title === "string") this.playbackState.title = info.videoData.title; if (Number.isInteger(info?.playerState)) this.playbackState.state = info.playerState; if (info?.videoData || Number.isInteger(info?.playerState)) { this.playbackState.ready = true; window.clearTimeout(this.readyTimer); this.emit(); } }
        if (message?.event === "onError" && Number.isInteger(message.info)) { const code = Number(message.info); this.playbackState.error = code === 2 ? "The video link is invalid." : code === 5 ? "YouTube could not start this video." : code === 100 ? "This video is private or unavailable." : code === 101 || code === 150 ? "The owner does not allow embedded playback." : code === 153 ? "YouTube did not receive the required page referrer." : `YouTube player error ${code}.`; window.clearTimeout(this.readyTimer); this.slot?.dispatchEvent(new CustomEvent("youtube-player-error", { detail: code })); this.emit(); }
      } catch {}
    });
    this.overlay.appendChild(this.frame);
    document.body.appendChild(this.overlay);
    this.tvCanvas.width = 1280;
    this.tvCanvas.height = 720;
    this.tvTexture.colorSpace = THREE.SRGBColorSpace;
    this.tvTexture.generateMipmaps = false;
    this.drawTVHome();
    const tvMaterial = this.office.tvScreen.material as THREE.MeshBasicMaterial;
    tvMaterial.map = this.tvTexture;
    tvMaterial.color.set(0xffffff);
    tvMaterial.toneMapped = false;
    tvMaterial.needsUpdate = true;
  }

  play(videoId: string, slot: HTMLElement, screen?: THREE.Mesh): void {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;
    const sameVideo = this.active && this.playbackState.videoId === videoId;
    this.slot = slot;
    this.source = slot.closest("#office-phone") ? "phone" : "pc";
    if (this.source === "pc") this.selectLaptopScreen(slot, screen);
    this.target = "auto";
    this.active = true;
    if (slot.closest("#boss-computer") && this.laptopScreen === this.office.bossLaptop.screen) this.office.setBossLaptopOpen(true);
    this.playbackState = { videoId, title: sameVideo ? this.playbackState.title : "", target: "auto", state: sameVideo ? this.playbackState.state : -1, ready: sameVideo && this.playbackState.ready, error: "", autoplayBlocked: false };
    if (!sameVideo) { this.frame.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&playsinline=1&controls=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`; window.clearTimeout(this.readyTimer); this.readyTimer = window.setTimeout(() => { if (this.active && !this.playbackState.ready) { this.playbackState.error = "YouTube did not respond. Check the player or try the link again."; this.emit(); } }, 20000); }
    this.setTVPlayback(false); this.emit();
    this.update();
  }

  get playback(): Readonly<YouTubePlayback> { return this.playbackState; }
  attach(slot: HTMLElement, screen?: THREE.Mesh): void { this.slot = slot; this.source = slot.closest("#office-phone") ? "phone" : "pc"; if (this.source === "pc") this.selectLaptopScreen(slot, screen); this.update(); }
  setDesktopPreview(preview: DesktopPreview, screen = this.office.bossLaptop.screen): void { const id = preview.desktopId; if (!id) return; const previous = this.desktopPreviews.get(id)?.preview; if (previous && previous.snapshotId === preview.snapshotId && !preview.videoRect) preview = { ...preview, videoRect: previous.videoRect, videoClipRect: previous.videoClipRect, videoVisibleRects: previous.videoVisibleRects }; this.desktopPreviews.set(id, { preview, screen }); if (this.source === "pc" && this.desktopId() === id) { this.laptopScreen = screen; this.update(); } }
  private desktopId(): string | undefined { return this.slot?.closest<HTMLElement>("[data-desktop-preview-id]")?.dataset.desktopPreviewId; }
  private selectLaptopScreen(slot: HTMLElement, screen?: THREE.Mesh): void { const id = slot.closest<HTMLElement>("[data-desktop-preview-id]")?.dataset.desktopPreviewId; this.laptopScreen = screen ?? (id ? this.desktopPreviews.get(id)?.screen : undefined) ?? this.office.bossLaptop.screen; }
  subscribe(listener: (playback: Readonly<YouTubePlayback>) => void): () => void { this.listeners.add(listener); listener(this.playbackState); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(this.playbackState); this.slot?.dispatchEvent(new CustomEvent("youtube-player-state", { detail: this.playbackState })); }
  private command(func: string, args: unknown[] = []): void { this.frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "https://www.youtube.com"); }
  pause(): void { this.command("pauseVideo"); }
  resume(): void { this.command("playVideo"); }
  setTarget(target: YouTubeTarget): void { this.target = target; this.playbackState.target = target; this.setTVPlayback(this.active && target === "tv"); this.emit(); this.update(); }
  private setTVPlayback(casting: boolean): void { this.setScreenTarget(casting ? this.office.tvScreen : undefined); }
  private setScreenTarget(screen?: THREE.Mesh): void { this.laptopCutout.visible = false; if (screen === this.activeScreen) return; if (this.activeScreen) { const material = this.screenMaterials.get(this.activeScreen); if (material) this.activeScreen.material = material; } this.activeScreen = screen; if (screen) { if (!this.screenMaterials.has(screen)) this.screenMaterials.set(screen, screen.material); screen.material = this.holeMaterial; } }

  stop(): void {
    this.active = false;
    window.clearTimeout(this.readyTimer);
    this.slot = undefined;
    this.frame.src = "about:blank";
    this.overlay.style.display = "none";
    this.playbackState = { videoId: "", title: "", target: "auto", state: -1, ready: false, error: "", autoplayBlocked: false }; this.setTVPlayback(false); this.emit();
  }

  update(): void {
    if (!this.active) return;
    this.overlay.style.visibility = "visible";
    const slot = this.target === "auto" ? this.slot : undefined;
    const rect = slot?.getBoundingClientRect();
    if (slot?.isConnected && rect && rect.width > 20 && rect.height > 20) {
      this.setScreenTarget();
      const phone = slot.closest<HTMLElement>("#office-phone"), app = slot.closest<HTMLElement>(".desktop-app-window"), content = slot.closest<HTMLElement>(phone ? ".phone-page" : ".desktop-app-content"), appRect = (phone?.querySelector<HTMLElement>(".phone-screen") ?? app)?.getBoundingClientRect(), contentRect = content?.getBoundingClientRect();
      const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const desktop = app?.closest<HTMLElement>("[data-desktop-preview-id]"), startMenu = desktop?.querySelector<HTMLElement>(".desktop-start-menu.open"), startRect = startMenu?.getBoundingClientRect();
      const occluders = desktop && app ? Array.from(desktop.querySelectorAll<HTMLElement>(".desktop-app-window.open,.terminal-window.open")).filter((other) => other !== app && Number(other.style.zIndex || 0) > Number(app.style.zIndex || 0)).map((other) => other.getBoundingClientRect()).filter((other) => intersects(rect, other)) : [];
      if (startRect && intersects(rect, startRect)) occluders.push(startRect);
      const blockedByGlobalUI = document.body.classList.contains("terminal-open") || document.body.classList.contains(phone ? "boss-computer-open" : "phone-open") || document.body.classList.contains("settings-open") || !!document.querySelector("dialog[open]");
      if (!(phone ?? app)?.classList.contains("open") || blockedByGlobalUI) { this.overlay.style.display = "none"; return; }
      this.overlay.style.display = "block";
      this.overlay.style.zIndex = phone ? "92" : "58";
      this.overlay.style.left = `${rect.left}px`;
      this.overlay.style.top = `${rect.top}px`;
      this.overlay.style.width = `${rect.width}px`;
      this.overlay.style.height = `${rect.height}px`;
      const bounds = [appRect, contentRect].filter((bound): bound is DOMRect => !!bound).reduce((visible, bound) => ({ left: Math.max(visible.left, bound.left), top: Math.max(visible.top, bound.top), right: Math.min(visible.right, bound.right), bottom: Math.min(visible.bottom, bound.bottom) }), { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom) });
      const regions = subtractVideoOcclusion({ x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }, occluders.map((cover) => ({ x: cover.left, y: cover.top, width: cover.width, height: cover.height })));
      this.overlay.style.clipPath = `path("${regions.map((area) => `M${area.x - rect.left},${area.y - rect.top}H${area.x + area.width - rect.left}V${area.y + area.height - rect.top}H${area.x - rect.left}Z`).join(" ") || "M0,0Z"}")`;
      this.overlay.style.transform = "none";
      this.overlay.style.pointerEvents = "none";
      return;
    }
    if (this.target !== "tv" && this.source === "phone") { this.setScreenTarget(); this.overlay.style.display = "none"; return; }
    this.overlay.style.clipPath = "none";
    this.overlay.style.zIndex = "0";
    if (this.target === "tv") { this.setScreenTarget(this.office.tvScreen); this.project(this.office.tvScreen); return; }
    this.setScreenTarget();
    const screen = this.laptopVideoSurface();
    if (!screen) { this.overlay.style.display = "none"; return; }
    this.project(screen);
  }

  private laptopVideoSurface(): THREE.Mesh | undefined {
    if (this.slot?.hidden || !this.slot?.closest(".desktop-app-window")?.classList.contains("open")) return;
    const id = this.desktopId(), preview = id ? this.desktopPreviews.get(id)?.preview : undefined, rect = preview?.videoRect, snapshot = preview?.snapshot;
    const image = (this.laptopScreen.material as THREE.MeshBasicMaterial).map?.image as { width?: number; height?: number } | undefined;
    if (!rect || !snapshot || !image?.width || !image.height || rect.width <= 0 || rect.height <= 0) return;
    const clip = preview?.videoClipRect ?? rect, regions = (preview?.videoVisibleRects ?? [clip]).map((area) => { const x = Math.max(0, area.x), y = Math.max(0, area.y); return { x, y, width: Math.min(snapshot.width, area.x + area.width) - x, height: Math.min(snapshot.height, area.y + area.height) - y }; }).filter((area) => area.width > 0 && area.height > 0);
    if (!regions.length) return;
    const scale = Math.min(image.width / snapshot.width, image.height / snapshot.height), offsetX = (image.width - snapshot.width * scale) / 2, offsetY = (image.height - snapshot.height * scale) / 2;
    const geometry = this.laptopScreen.geometry as THREE.PlaneGeometry, width = geometry.parameters.width, height = geometry.parameters.height;
    const fit = (mesh: THREE.Mesh, x: number, y: number, w: number, h: number) => { mesh.position.set(((offsetX + (x + w / 2) * scale) / image.width! - 0.5) * width, (0.5 - (offsetY + (y + h / 2) * scale) / image.height!) * height, 0.002); mesh.scale.set(w * scale / image.width! * width, h * scale / image.height! * height, 1); };
    if (this.laptopCutout.parent !== this.laptopScreen) this.laptopScreen.add(this.laptopCutout, this.laptopProjection);
    const signature = `${this.laptopScreen.uuid}|${snapshot.width},${snapshot.height}|${image.width},${image.height}|${JSON.stringify(regions)}`;
    if (signature !== this.laptopCutoutSignature) {
      const vertices: number[] = [];
      for (const area of regions) { const left = ((offsetX + area.x * scale) / image.width - 0.5) * width, right = ((offsetX + (area.x + area.width) * scale) / image.width - 0.5) * width, top = (0.5 - (offsetY + area.y * scale) / image.height) * height, bottom = (0.5 - (offsetY + (area.y + area.height) * scale) / image.height) * height; vertices.push(left, top, 0.002, left, bottom, 0.002, right, top, 0.002, right, top, 0.002, left, bottom, 0.002, right, bottom, 0.002); }
      this.laptopCutout.geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3)); this.laptopCutout.geometry.computeBoundingSphere(); this.laptopCutoutSignature = signature;
    }
    fit(this.laptopProjection, rect.x, rect.y, rect.width, rect.height); this.laptopCutout.visible = true;
    return this.laptopProjection;
  }

  private project(screen: THREE.Mesh): void {
    const geometry = screen.geometry as THREE.PlaneGeometry;
    const width = geometry.parameters.width, height = geometry.parameters.height;
    screen.updateWorldMatrix(true, false);
    this.office.camera.updateMatrixWorld(true);
    screen.getWorldPosition(this.center); this.normal.set(0, 0, 1).transformDirection(screen.matrixWorld); this.office.camera.getWorldPosition(this.cameraPosition); this.toCamera.copy(this.cameraPosition).sub(this.center);
    if (this.normal.dot(this.toCamera) <= 0) { this.overlay.style.display = "none"; return; }
    const corners = this.corners;
    corners[0].set(-width / 2, height / 2, 0); corners[1].set(width / 2, height / 2, 0); corners[2].set(width / 2, -height / 2, 0); corners[3].set(-width / 2, -height / 2, 0);
    for (const point of corners) point.applyMatrix4(screen.matrixWorld).project(this.office.camera);
    if (corners.some((point) => point.z < -1 || point.z > 1)) { this.overlay.style.display = "none"; return; }
    const points = corners.map((point) => ({ x: (point.x + 1) * innerWidth / 2, y: (1 - point.y) * innerHeight / 2 }));
    const [p0, p1, p2, p3] = points;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
    const denominator = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(denominator) < 0.0001) { this.overlay.style.display = "none"; return; }
    const g = (dx3 * dy2 - dx2 * dy3) / denominator, h = (dx1 * dy3 - dx3 * dy1) / denominator;
    const a = p1.x - p0.x + g * p1.x, b = p1.y - p0.y + g * p1.y, c = p3.x - p0.x + h * p3.x, d = p3.y - p0.y + h * p3.y;
    this.overlay.style.display = "block";
    this.overlay.style.left = "0px";
    this.overlay.style.top = "0px";
    this.overlay.style.width = `${VIDEO_WIDTH}px`;
    this.overlay.style.height = `${VIDEO_HEIGHT}px`;
    this.overlay.style.transform = `matrix3d(${a / VIDEO_WIDTH},${b / VIDEO_WIDTH},0,${g / VIDEO_WIDTH},${c / VIDEO_HEIGHT},${d / VIDEO_HEIGHT},0,${h / VIDEO_HEIGHT},0,0,1,0,${p0.x},${p0.y},0,1)`;
    this.overlay.style.pointerEvents = "none";
  }

  private drawTVHome(): void {
    const ctx = this.tvCanvas.getContext("2d");
    if (!ctx) return;
    const background = ctx.createLinearGradient(0, 0, 1280, 720);
    background.addColorStop(0, "#07111f"); background.addColorStop(0.55, "#10243a"); background.addColorStop(1, "#142f46");
    ctx.fillStyle = background; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = "#d8e5f3"; ctx.font = "700 22px system-ui, sans-serif"; ctx.fillText("OFFICE TV", 64, 58);
    ctx.fillStyle = "#91a5ba"; ctx.font = "500 17px system-ui, sans-serif"; ctx.fillText("HOME", 236, 58); ctx.fillText("APPS", 330, 58);
    ctx.fillStyle = "#e8f0f8"; ctx.font = "600 36px system-ui, sans-serif"; ctx.fillText("Your entertainment", 64, 136);
    ctx.fillStyle = "#91a5ba"; ctx.font = "16px system-ui, sans-serif"; ctx.fillText(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), 1130, 58);
    const card = ctx.createLinearGradient(64, 180, 1216, 604);
    card.addColorStop(0, "#172e49"); card.addColorStop(1, "#0c1c2d");
    ctx.fillStyle = card; ctx.fillRect(64, 180, 1152, 424);
    ctx.strokeStyle = "#ffffff20"; ctx.lineWidth = 2; ctx.strokeRect(65, 181, 1150, 422);
    ctx.fillStyle = "#dce8f5"; ctx.font = "700 14px system-ui, sans-serif"; ctx.fillText("FEATURED APP", 100, 224);
    ctx.fillStyle = "#e62117"; ctx.fillRect(100, 258, 126, 88);
    ctx.beginPath(); ctx.moveTo(151, 278); ctx.lineTo(151, 326); ctx.lineTo(190, 302); ctx.closePath(); ctx.fillStyle = "white"; ctx.fill();
    ctx.fillStyle = "#f4f7fb"; ctx.font = "700 46px system-ui, sans-serif"; ctx.fillText("YouTube", 100, 410);
    ctx.fillStyle = "#b3c3d4"; ctx.font = "20px system-ui, sans-serif"; ctx.fillText("Videos, music and live streams", 100, 450);
    ctx.fillStyle = "#203f59"; ctx.fillRect(100, 494, 262, 48);
    ctx.fillStyle = "#e7f1fa"; ctx.font = "700 15px system-ui, sans-serif"; ctx.fillText("READY TO PLAY", 124, 524);
    ctx.fillStyle = "#aabdd0"; ctx.font = "16px system-ui, sans-serif"; ctx.fillText("Open YouTube on the Office PC and choose Play on TV.", 100, 572);
    ctx.fillStyle = "#0a1727"; ctx.fillRect(840, 222, 344, 334);
    ctx.strokeStyle = "#ffffff18"; ctx.strokeRect(841, 223, 342, 332);
    ctx.fillStyle = "#91a5ba"; ctx.font = "700 13px system-ui, sans-serif"; ctx.fillText("NOW PLAYING", 870, 260);
    ctx.fillStyle = "#d8e5f3"; ctx.font = "600 22px system-ui, sans-serif"; ctx.fillText("Nothing playing", 870, 316);
    ctx.fillStyle = "#91a5ba"; ctx.font = "16px system-ui, sans-serif"; ctx.fillText("Your next video will appear here.", 870, 350);
    this.tvTexture.needsUpdate = true;
  }
}
