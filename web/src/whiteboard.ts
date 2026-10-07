import * as THREE from "three";
import { api } from "./api";
import type { Office } from "./office";
import { surfaceMaterial } from "./materials";

export interface StrokePoint {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  points: StrokePoint[];
  color: string;
  width: number;
  tool: "pen" | "eraser";
}

const PALETTE = ["#1b2430", "#c0392b", "#2f6fd0", "#2f9e5f", "#e8a020", "#7b5ea7"];
const ERASER_WIDTH = 0.05;
const PEN_WIDTH = 0.006;

export class Whiteboard {
  readonly strokes: Stroke[] = [];
  readonly texture: THREE.CanvasTexture;
  private plane: THREE.Mesh;
  private frame = new THREE.Group();
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private editor: HTMLElement | null = null;
  private active: Stroke | null = null;
  private color = PALETTE[0];
  private erasing = false;
  private dirty = true;
  private saveTimer = 0;
  private readOnly: boolean;
  private resizeObserver: ResizeObserver | null = null;
  private dragOffset: { x: number; y: number } | null = null;

  constructor(office: Office, readOnly: boolean) {
    this.readOnly = readOnly;
    this.canvas.width = 1024;
    this.canvas.height = 640;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(5.2, 2.2),
      new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.94 })
    );
    const point = office.whiteboardAnchor;
    this.plane.position.set(point.x, point.y, point.z);
    this.plane.rotation.y = point.yaw;
    this.plane.translateZ(-0.034);
    this.frame.position.set(point.x, point.y, point.z); this.frame.rotation.y = point.yaw;
    const frameMaterial = surfaceMaterial(0xc7b99f, 0.34, 0.6), back = new THREE.Mesh(new THREE.BoxGeometry(5.46, 2.46, 0.08), surfaceMaterial(0xe4dfd3, 0.88));
    back.position.z = -0.075; this.frame.add(back);
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 5.5, 24), frameMaterial);
    rail.rotation.z = Math.PI / 2;
    const top = rail.clone(), bottom = rail.clone(); top.position.set(0, 1.19, 0.025); bottom.position.set(0, -1.19, 0.025); this.frame.add(top, bottom);
    const sideRail = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.34, 24), frameMaterial);
    const left = sideRail.clone(), right = sideRail.clone(); left.position.set(-2.69, 0, 0.025); right.position.set(2.69, 0, 0.025); this.frame.add(left, right);
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.12, 0.2), frameMaterial); tray.position.set(0, -1.27, 0.08); this.frame.add(tray);
    const lip = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.78, 16), frameMaterial); lip.rotation.z = Math.PI / 2; lip.position.set(0, -1.19, 0.176); this.frame.add(lip);
    for (const [index, color] of [0x648ca7, 0xc77962, 0x709675].entries()) {
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 20), surfaceMaterial(0xe9e8df, 0.48));
      marker.rotation.z = Math.PI / 2; marker.position.set(0, -1.18, 0.01 + index * 0.058); this.frame.add(marker);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.07, 20), surfaceMaterial(color, 0.4)); cap.position.y = 0.12; marker.add(cap);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0255, 0.0255, 0.028, 20), surfaceMaterial(color, 0.4)); band.position.y = -0.07; marker.add(band);
    }
    for (const x of [-2.45, 2.45]) {
      const magnet = new THREE.Mesh(new THREE.SphereGeometry(0.055, 20, 14), surfaceMaterial(x < 0 ? 0xe6a17c : 0x86bdad, 0.35));
      magnet.scale.z = 0.45;
      magnet.position.set(x, 1.04, -0.014); this.frame.add(magnet);
    }
    for (const x of [-2.69, 2.69]) for (const y of [-1.19, 1.19]) {
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.008, 12), surfaceMaterial(0x68717a, 0.25, 0.75)); screw.rotation.x = Math.PI / 2; screw.position.set(x, y, 0.073); this.frame.add(screw);
    }
    office.scene.add(this.frame);
    office.scene.add(this.plane);
  }

  async load(): Promise<void> {
    try {
      const saved = await api.request<Stroke[]>("whiteboard_get");
      if (Array.isArray(saved)) this.strokes.push(...saved);
    } catch {
      /* a fresh board is fine */
    }
    this.dirty = true;
  }

  get canDraw(): boolean {
    return !this.readOnly;
  }

  setTool(color: string, erasing: boolean): void {
    this.color = color;
    this.erasing = erasing;
    for (const swatch of this.editor?.querySelectorAll<HTMLElement>("[data-color]") ?? []) {
      swatch.classList.toggle("on", !erasing && swatch.dataset.color === color);
    }
    this.editor?.querySelector<HTMLElement>("[data-tool]")?.classList.toggle("on", erasing);
  }

  strokeOnWall(point: StrokePoint, pressed: boolean): void {
    if (pressed) this.begin(point);
    else this.extend(point);
  }

  endStroke(): void {
    this.end();
  }

  private begin(point: StrokePoint): void {
    if (!this.canDraw) return;
    this.active = {
      id: Math.random().toString(36).slice(2),
      points: [point],
      color: this.erasing ? "#ffffff" : this.color,
      width: this.erasing ? ERASER_WIDTH : PEN_WIDTH,
      tool: this.erasing ? "eraser" : "pen"
    };
    this.strokes.push(this.active);
    this.dirty = true;
  }

  private extend(point: StrokePoint): void {
    if (!this.active) return;
    const last = this.active.points[this.active.points.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) < 0.004) return;
    this.active.points.push(point);
    this.dirty = true;
  }

  private end(): void {
    if (!this.active) return;
    if (this.active.points.length < 2) this.strokes.pop();
    this.active = null;
    this.queueSave();
  }

  private drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, w: number, h: number): void {
    const points = stroke.points;
    if (points.length === 0) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(1.5, stroke.width * w);
    ctx.beginPath();
    ctx.moveTo(points[0].x * w, points[0].y * h);
    if (points.length === 2) {
      ctx.lineTo(points[1].x * w, points[1].y * h);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const midX = ((points[i].x + points[i + 1].x) / 2) * w;
        const midY = ((points[i].y + points[i + 1].y) / 2) * h;
        ctx.quadraticCurveTo(points[i].x * w, points[i].y * h, midX, midY);
      }
      const end = points[points.length - 1];
      ctx.lineTo(end.x * w, end.y * h);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  private redraw(): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fdfdfa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of this.strokes) this.drawStroke(ctx, stroke, canvas.width, canvas.height);
    this.texture.needsUpdate = true;
  }

  private queueSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      api.send("whiteboard_save", { strokes: this.strokes });
    }, 700);
  }

  clear(): void {
    if (!this.canDraw) return;
    this.strokes.length = 0;
    this.dirty = true;
    this.queueSave();
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.redraw();
  }

  /** Normalized board coordinates from a pointer event over the editor canvas. */
  private fromEditor(event: PointerEvent): StrokePoint {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height
    };
  }

  /** Normalized board coordinates from a ray hitting the wall in 3D. */
  fromRay(raycaster: THREE.Raycaster): StrokePoint | null {
    const hit = raycaster.intersectObject(this.plane, false)[0];
    if (!hit?.uv) return null;
    return { x: hit.uv.x, y: 1 - hit.uv.y };
  }

  get isOpen(): boolean {
    return this.editor !== null && (!this.editor.classList.contains("desktop-window") || !!this.editor.closest("#boss-computer")?.classList.contains("open"));
  }

  openEditor(windowLayer?: HTMLElement): void {
    if (this.editor) return;
    const root = document.createElement("section");
    root.className = "panel";
    if (windowLayer) root.classList.add("desktop-window");
    root.id = "board";
    root.innerHTML = `
      <header>
        <span class="title">Whiteboard</span>
        <span class="spacer"></span>
        <span class="hint"></span>
        <button data-act="clear">Clear</button>
        <button data-act="close">Close</button>
      </header>
      <div class="surface"></div>
      <footer>
        <button data-tool> Eraser</button>
        <span class="swatches"></span>
        <span class="spacer"></span>
        <span class="saved">saved to the office</span>
      </footer>`;
    (windowLayer ?? document.body).appendChild(root);
    this.editor = root;
    const surface = root.querySelector<HTMLElement>(".surface")!;
    surface.appendChild(this.canvas);
    if (windowLayer) {
      const header = root.querySelector<HTMLElement>("header")!;
      header.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        const bounds = root.getBoundingClientRect();
        this.dragOffset = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        header.setPointerCapture(event.pointerId);
      });
      header.addEventListener("pointermove", (event) => {
        if (!this.dragOffset) return;
        const bounds = windowLayer.getBoundingClientRect();
        root.style.left = `${Math.max(0, Math.min(bounds.width - root.offsetWidth, event.clientX - bounds.left - this.dragOffset.x))}px`;
        root.style.top = `${Math.max(0, Math.min(bounds.height - root.offsetHeight, event.clientY - bounds.top - this.dragOffset.y))}px`;
        root.style.transform = "none";
      });
      const stopDrag = () => { this.dragOffset = null; };
      header.addEventListener("pointerup", stopDrag);
      header.addEventListener("pointercancel", stopDrag);
    }

    if (this.readOnly) {
      root.querySelector<HTMLElement>("footer")!.remove();
      root.querySelector<HTMLElement>('[data-act="clear"]')!.remove();
      root.querySelector<HTMLElement>(".hint")!.textContent = "read-only";
    }

    root.querySelector<HTMLElement>('[data-act="close"]')!.addEventListener("click", () => this.closeEditor());

    if (!this.readOnly) {
      const swatches = root.querySelector<HTMLElement>(".swatches")!;
      for (const color of PALETTE) {
        const swatch = document.createElement("button");
        swatch.dataset.color = color;
        swatch.style.background = color;
        swatch.addEventListener("click", () => this.setTool(color, false));
        swatches.appendChild(swatch);
      }
      root.querySelector<HTMLElement>("[data-tool]")!.addEventListener("click", () => this.setTool(this.color, !this.erasing));
      root.querySelector<HTMLElement>('[data-act="clear"]')!.addEventListener("click", () => this.clear());
      surface.addEventListener("pointerdown", (event) => {
        surface.setPointerCapture(event.pointerId);
        this.begin(this.fromEditor(event));
      });
      surface.addEventListener("pointermove", (event) => {
        if (surface.hasPointerCapture(event.pointerId)) this.extend(this.fromEditor(event));
      });
      surface.addEventListener("pointerup", () => this.end());
      surface.addEventListener("pointercancel", () => this.end());
    }
    this.setTool(this.color, this.erasing);
    this.resizeSurface();
    this.resizeObserver = new ResizeObserver(() => this.resizeSurface());
    this.resizeObserver.observe(root);
  }

  closeEditor(): void {
    if (!this.editor) return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.editor.remove();
    this.editor = null;
    this.canvas.style.width = "";
    this.canvas.style.height = "";
  }

  private resizeSurface(): void {
    if (!this.editor) return;
    const surface = this.editor.querySelector<HTMLElement>(".surface")!;
    const box = surface.getBoundingClientRect();
    const scale = Math.min(box.width / this.canvas.width, box.height / this.canvas.height);
    this.canvas.style.width = `${this.canvas.width * scale}px`;
    this.canvas.style.height = `${this.canvas.height * scale}px`;
  }

  onResize(): void {
    this.resizeSurface();
  }
}
