import * as THREE from "three";

export type WallId = "north" | "south" | "east" | "west";
export interface WallPoint { wall: WallId; u: number; y: number }
export interface WallArtPlacement { id: string; url: string; title?: string; wall: WallId; u: number; y: number; w: number; h: number; frame: number }
export const WALL_FRAMES = [{ name: "Wood", color: "#c98b5a" }, { name: "Black", color: "#2b2d42" }, { name: "White", color: "#fffaf3" }, { name: "Gold", color: "#e9b949" }, { name: "Coral", color: "#ff8a5b" }, { name: "Teal", color: "#2a9d8f" }] as const;
const border = 0.07;
const textureMax = 1024;
const pictureCache = new Map<string, Promise<{ texture: THREE.CanvasTexture; aspect: number; src: string }>>();

function validImageURL(raw: string): string | null {
  try { const url = new URL(raw.trim()); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function loadPicture(url: string): Promise<{ texture: THREE.CanvasTexture; aspect: number; src: string }> {
  let result = pictureCache.get(url);
  if (!result) {
    result = fetch(`/wall-image?url=${encodeURIComponent(url)}`).then(async (response) => {
      if (!response.ok) throw new Error((await response.text()) || `Image request failed (${response.status})`);
      const src = URL.createObjectURL(await response.blob());
      try {
        const image = new Image(); image.src = src; await image.decode();
        const width = image.naturalWidth || textureMax, height = image.naturalHeight || textureMax, scale = Math.min(1, textureMax / Math.max(width, height));
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
        return { texture, aspect: width / height, src };
      } catch { URL.revokeObjectURL(src); throw new Error("Your browser can't display that image"); }
    });
    result.catch(() => { if (pictureCache.get(url) === result) pictureCache.delete(url); });
    pictureCache.set(url, result);
  }
  return result;
}

function prunePictures(keep: Set<string>): void {
  for (const [url, promise] of pictureCache) if (!keep.has(url)) {
    pictureCache.delete(url);
    promise.then(({ texture, src }) => { texture.dispose(); URL.revokeObjectURL(src); }, () => {});
  }
}

export function wallPose(wall: WallId, u: number, y: number, width: number, depth: number, out = 0.22): { x: number; y: number; z: number; rotY: number } {
  switch (wall) {
    case "north": return { x: u, y, z: -depth / 2 + out, rotY: 0 };
    case "south": return { x: u, y, z: depth / 2 - out, rotY: Math.PI };
    case "west": return { x: -width / 2 + out, y, z: u, rotY: Math.PI / 2 };
    case "east": return { x: width / 2 - out, y, z: u, rotY: -Math.PI / 2 };
  }
}

function zones(wall: WallId, width: number, depth: number): { u0: number; u1: number; y0: number; y1: number }[] {
  const minU = wall === "north" || wall === "south" ? -width / 2 : -depth / 2, maxU = -minU, wallTop = 7.2;
  const spans = wall === "north" ? [[minU, -14.15], [14.15, maxU]] : wall === "south" ? [[minU, -12.15], [-7.35, -4.65], [0.15, 7.65], [14.55, maxU]] : wall === "east" ? [[minU, -3.45], [3.45, 5.8], [10.45, maxU]] : [[minU, 5.25], [7.75, maxU]];
  const result = spans.map(([u0, u1]) => ({ u0, u1, y0: 0.18, y1: wallTop }));
  if (wall !== "north") result.push({ u0: minU, u1: maxU, y0: 0.18, y1: wall === "east" ? 0.48 : 0.94 }, { u0: minU, u1: maxU, y0: wall === "east" ? 4.45 : 6.78, y1: wallTop });
  if (wall === "north") result.push({ u0: minU, u1: maxU, y0: 6.78, y1: wallTop });
  if (wall === "west") result.push({ u0: 5.3, u1: 7.7, y0: 2.55, y1: wallTop });
  return result;
}

function fitToWall(wall: WallId, u: number, y: number, w: number, h: number, width: number, depth: number): { u: number; y: number } | null {
  let best: { u: number; y: number } | null = null, bestDistance = Infinity;
  for (const zone of zones(wall, width, depth)) {
    const u0 = zone.u0 + border + w / 2, u1 = zone.u1 - border - w / 2, y0 = zone.y0 + border + h / 2, y1 = zone.y1 - border - h / 2;
    if (u0 > u1 || y0 > y1) continue;
    const at = { u: THREE.MathUtils.clamp(u, u0, u1), y: THREE.MathUtils.clamp(y, y0, y1) }, distance = (at.u - u) ** 2 + (at.y - y) ** 2;
    if (distance < bestDistance) { best = at; bestDistance = distance; }
  }
  return best;
}

export function fitWallPoint(point: WallPoint, w: number, h: number, width: number, depth: number): WallPoint | null {
  const at = fitToWall(point.wall, point.u, point.y, w, h, width, depth);
  return at ? { wall: point.wall, ...at } : null;
}

export function aimAtRoomWall(ray: THREE.Ray, width: number, depth: number): WallPoint | null {
  const { x, y, z } = ray.origin, d = ray.direction;
  if (x < -width / 2 || x > width / 2 || z < -depth / 2 || z > depth / 2 || y < 0) return null;
  const hits: [WallId, number][] = [];
  if (d.z < 0) hits.push(["north", (-depth / 2 - z) / d.z]);
  if (d.z > 0) hits.push(["south", (depth / 2 - z) / d.z]);
  if (d.x < 0) hits.push(["west", (-width / 2 - x) / d.x]);
  if (d.x > 0) hits.push(["east", (width / 2 - x) / d.x]);
  let best: WallPoint | null = null, distance = 60;
  for (const [wall, t] of hits) {
    if (!(t > 0 && t < distance)) continue;
    const pointY = y + d.y * t, u = wall === "north" || wall === "south" ? x + d.x * t : z + d.z * t;
    if (pointY < 0.15 || pointY > 7.2) continue;
    best = { wall, u, y: pointY }; distance = t;
  }
  return best;
}

function pictureSize(longSide: number, aspect: number): { w: number; h: number } {
  const size = THREE.MathUtils.clamp(longSide, 0.3, 3.4), ratio = THREE.MathUtils.clamp(aspect, 0.2, 5);
  return ratio >= 1 ? { w: size, h: size / ratio } : { w: size * ratio, h: size };
}

function overlaps(a: WallArtPlacement, b: WallArtPlacement): boolean {
  return a.wall === b.wall && Math.abs(a.u - b.u) < (a.w + b.w) / 2 + border * 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + border * 2;
}

interface PictureView { item: WallArtPlacement; group: THREE.Group; picture: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> }

export class WallArtGallery {
  readonly group = new THREE.Group();
  private frames = new Map<string, PictureView>();
  private items: WallArtPlacement[] = [];
  private draft: { url: string; title: string; frame: number; size: number; picture: { texture: THREE.CanvasTexture; aspect: number; src: string } } | null = null;
  private ghost = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x06d6a0, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
  private spot: WallArtPlacement | null = null;
  private dialog?: HTMLDialogElement;
  private width: number;
  private depth: number;

  constructor(private scene: THREE.Scene, width: number, depth: number) {
    this.width = width; this.depth = depth;
    this.ghost.visible = false;
    this.scene.add(this.group, this.ghost);
  }

  sync(items: readonly WallArtPlacement[]): void {
    this.items = Array.from(items ?? []);
    const active = new Set(this.items.map((item) => item.id));
    for (const item of this.items) {
      let view = this.frames.get(item.id);
      const keyChanged = view && (view.item.url !== item.url || view.item.w !== item.w || view.item.h !== item.h || view.item.frame !== item.frame);
      if (keyChanged) { this.drop(view!); view = undefined; }
      if (!view) { view = this.build(item); this.frames.set(item.id, view); }
      view.item = item;
      const pose = wallPose(item.wall, item.u, item.y, this.width, this.depth);
      view.group.position.set(pose.x, pose.y, pose.z); view.group.rotation.y = pose.rotY;
    }
    for (const [id, view] of this.frames) if (!active.has(id)) { this.drop(view); this.frames.delete(id); }
    this.prune();
  }

  get active(): boolean { return !!this.draft; }
  get isDialogOpen(): boolean { return !!this.dialog?.open; }
  get placements(): readonly WallArtPlacement[] { return this.items; }
  get hasSpot(): boolean { return !!this.spot?.id; }
  overlaps(point: WallPoint, w: number, h: number): boolean {
    const rect = { id: "note", url: "", wall: point.wall, u: point.u, y: point.y, w, h, frame: 0 };
    return this.items.some((item) => overlaps(item, rect));
  }

  async begin(): Promise<void> {
    if (this.draft) return;
    const dialog = document.createElement("dialog"); dialog.className = "sticky-note-dialog wall-art-dialog";
    dialog.innerHTML = `<form><header><strong>Hang a picture</strong><button type="button" data-close aria-label="Close">×</button></header><label>Image link</label><input data-url type="url" placeholder="https://…/picture.png" autocomplete="off"><label>Title</label><input data-title maxlength="80" placeholder="Optional title"><label>Frame</label><select data-frame>${WALL_FRAMES.map((frame, index) => `<option value="${index}">${frame.name}</option>`).join("")}</select><label>Size</label><input data-size type="range" min="0.3" max="3.4" step="0.1" value="1.2"><div data-preview class="wall-art-preview"></div><p data-status class="wall-art-status">Paste an image link to preview it.</p><footer><button type="button" data-cancel>Cancel</button><button type="submit" data-place disabled>Choose wall position</button></footer></form>`;
    const form = dialog.querySelector("form")!, urlInput = dialog.querySelector<HTMLInputElement>("[data-url]")!, titleInput = dialog.querySelector<HTMLInputElement>("[data-title]")!, frameInput = dialog.querySelector<HTMLSelectElement>("[data-frame]")!, sizeInput = dialog.querySelector<HTMLInputElement>("[data-size]")!, preview = dialog.querySelector<HTMLElement>("[data-preview]")!, status = dialog.querySelector<HTMLElement>("[data-status]")!, submit = dialog.querySelector<HTMLButtonElement>("[data-place]")!;
    this.dialog = dialog;
    let currentUrl = "", currentPicture: { texture: THREE.CanvasTexture; aspect: number; src: string } | null = null, sequence = 0, timer = 0;
    const load = async () => {
      const seq = ++sequence, url = validImageURL(urlInput.value);
      currentUrl = ""; currentPicture = null; submit.disabled = true; preview.replaceChildren();
      if (!url) { status.textContent = urlInput.value.trim() ? "Use a valid http or https image link." : "Paste an image link to preview it."; return; }
      status.textContent = "Loading image…";
      try {
        const picture = await loadPicture(url);
        if (seq !== sequence) return;
        currentUrl = url; currentPicture = picture; preview.replaceChildren(Object.assign(document.createElement("img"), { src: picture.src, alt: "Picture preview" }));
        status.textContent = "Aim at a solid wall and press E to hang it."; submit.disabled = false;
      } catch (problem) { if (seq === sequence) status.textContent = (problem as Error).message; }
    };
    urlInput.addEventListener("input", () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 320); });
    for (const input of [urlInput, titleInput]) input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing && currentPicture) { event.preventDefault(); form.requestSubmit(); } });
    const close = () => { sequence++; window.clearTimeout(timer); dialog.close(); dialog.remove(); if (this.dialog === dialog) this.dialog = undefined; this.prune(); };
    dialog.querySelector("[data-close]")!.addEventListener("click", close);
    dialog.querySelector("[data-cancel]")!.addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!currentPicture || !currentUrl) return;
      this.draft = { url: currentUrl, title: titleInput.value.trim().slice(0, 80), frame: Math.max(0, Math.min(5, Number(frameInput.value) || 0)), size: Number(sizeInput.value) || 1.2, picture: currentPicture };
      this.spot = null; this.ghost.visible = false; close();
    });
    document.body.append(dialog); dialog.showModal(); window.setTimeout(() => urlInput.focus(), 0);
  }

  update(ray: THREE.Ray): void {
    if (!this.draft) return;
    const hit = aimAtRoomWall(ray, this.width, this.depth);
    if (!hit) { this.spot = null; this.ghost.visible = false; return; }
    const size = pictureSize(this.draft.size, this.draft.picture.aspect), fit = fitToWall(hit.wall, hit.u, hit.y, size.w, size.h, this.width, this.depth);
    if (!fit) { this.spot = null; this.ghost.visible = false; return; }
    const candidate: WallArtPlacement = { id: "preview", url: this.draft.url, title: this.draft.title, wall: hit.wall, u: fit.u, y: fit.y, w: size.w, h: size.h, frame: this.draft.frame };
    const blocked = this.items.some((item) => overlaps(item, candidate));
    this.spot = blocked ? null : candidate;
    const pose = wallPose(hit.wall, fit.u, fit.y, this.width, this.depth, blocked ? 0.35 : 0.22);
    this.ghost.position.set(pose.x, pose.y, pose.z); this.ghost.rotation.y = pose.rotY; this.ghost.scale.set(size.w + 0.3, size.h + 0.3, 1);
    this.ghost.material.color.set(blocked ? 0xef476f : 0x06d6a0); this.ghost.visible = true;
  }

  place(): WallArtPlacement | null {
    if (!this.draft || !this.spot) return null;
    const placement = { ...this.spot, id: crypto.randomUUID(), url: this.draft.url, title: this.draft.title, frame: this.draft.frame };
    this.draft = null; this.spot = null; this.ghost.visible = false;
    return placement;
  }

  cancel(): void { this.draft = null; this.spot = null; this.ghost.visible = false; this.prune(); }

  dispose(): void {
    for (const view of this.frames.values()) this.drop(view);
    this.frames.clear(); this.scene.remove(this.group, this.ghost); this.ghost.geometry.dispose(); this.ghost.material.dispose(); prunePictures(new Set());
  }

  private build(item: WallArtPlacement): PictureView {
    const group = new THREE.Group(), w = item.w, h = item.h, frameWidth = w + border * 2, frameHeight = h + border * 2, frameColor = new THREE.Color(WALL_FRAMES[item.frame]?.color ?? WALL_FRAMES[0].color), frame = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.56, metalness: item.frame === 3 ? 0.28 : 0.04 }), backing = new THREE.MeshStandardMaterial({ color: 0xeadfca, roughness: 0.88 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(frameWidth, frameHeight, 0.06), new THREE.MeshStandardMaterial({ color: 0x786b58, roughness: 0.82 })); group.add(back);
    const mat = new THREE.Mesh(new THREE.BoxGeometry(w + 0.025, h + 0.025, 0.025), backing); mat.position.z = 0.026; group.add(mat);
    const bars = [new THREE.Mesh(new THREE.BoxGeometry(frameWidth, border, 0.1), frame), new THREE.Mesh(new THREE.BoxGeometry(frameWidth, border, 0.1), frame), new THREE.Mesh(new THREE.BoxGeometry(border, h, 0.1), frame), new THREE.Mesh(new THREE.BoxGeometry(border, h, 0.1), frame)];
    bars[0].position.y = h / 2 + border / 2; bars[1].position.y = -h / 2 - border / 2; bars[2].position.x = -w / 2 - border / 2; bars[3].position.x = w / 2 + border / 2; group.add(...bars);
    const highlight = new THREE.MeshStandardMaterial({ color: frameColor.clone().lerp(new THREE.Color(0xffffff), 0.34), roughness: 0.5 }), shade = new THREE.MeshStandardMaterial({ color: frameColor.clone().multiplyScalar(0.72), roughness: 0.72 });
    const accents = [new THREE.Mesh(new THREE.BoxGeometry(frameWidth - border * 0.35, border * 0.11, 0.035), highlight), new THREE.Mesh(new THREE.BoxGeometry(frameWidth - border * 0.35, border * 0.11, 0.035), shade), new THREE.Mesh(new THREE.BoxGeometry(border * 0.11, h - border * 0.35, 0.035), highlight), new THREE.Mesh(new THREE.BoxGeometry(border * 0.11, h - border * 0.35, 0.035), shade)];
    accents[0].position.set(0, h / 2 + border * 0.76, 0.045); accents[1].position.set(0, -h / 2 - border * 0.76, 0.045); accents[2].position.set(-w / 2 - border * 0.76, 0, 0.045); accents[3].position.set(w / 2 + border * 0.76, 0, 0.045); group.add(...accents);
    const picture = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xe9ecef, side: THREE.DoubleSide })); picture.position.z = 0.056; group.add(picture);
    loadPicture(item.url).then((asset) => { if (!this.frames.has(item.id)) return; picture.material.map = asset.texture; picture.material.color.set(0xffffff); picture.material.needsUpdate = true; this.crop(picture, asset.aspect); }, () => { if (this.frames.has(item.id)) picture.material.color.set(0xf2d7c7); });
    this.group.add(group); return { item, group, picture };
  }

  private crop(picture: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>, aspect: number): void {
    const shape = picture.geometry.parameters.width / picture.geometry.parameters.height, fx = aspect > shape ? shape / aspect : 1, fy = aspect > shape ? 1 : aspect / shape, uv = picture.geometry.attributes.uv;
    [[0, 1], [1, 1], [0, 0], [1, 0]].forEach(([u, v], index) => uv.setXY(index, 0.5 + (u - 0.5) * fx, 0.5 + (v - 0.5) * fy)); uv.needsUpdate = true;
  }

  private drop(view: PictureView): void { this.group.remove(view.group); view.group.traverse((object) => { const mesh = object as THREE.Mesh; if (!mesh.isMesh) return; mesh.geometry.dispose(); if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose()); else mesh.material.dispose(); }); }
  private prune(): void { const keep = new Set(this.items.map((item) => item.url)); if (this.draft) keep.add(this.draft.url); prunePictures(keep); }
}
