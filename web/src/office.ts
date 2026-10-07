import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { surfaceMaterial } from "./materials";
import { OfficeModels } from "./models";
import { CoffeeStation } from "./coffee";
import { mergeStaticMeshes } from "./static_geometry";
import { buildExterior, EXIT_DOOR_OPENING_WIDTH } from "./building";
import { buildOutdoor, setOutdoorNight, updateOutdoor } from "./outdoor";
import { buildLoft } from "./loft";
import { WeatherSystem } from "./weather";
import { WallArtGallery, aimAtRoomWall, fitWallPoint, wallPose, type WallArtPlacement, type WallPoint, type WallId } from "./wall_art";
import { ELEVATOR_LAYOUT, OfficeElevator } from "./elevator";

export interface Laptop {
  pivot: THREE.Group;
  screen: THREE.Mesh;
  base: THREE.Mesh;
  badge: THREE.Mesh;
  keyboard: THREE.Group;
}

export interface Seat {
  id: number;
  x: number;
  z: number;
  yaw: number;
  occupant: string | null;
  chair: THREE.Group;
  marker: THREE.Group;
  laptop: Laptop | null;
  lid: number;
  lidTarget: number;
}

export interface OfficeOptions {
  podsX: number;
  podsZ: number;
  podGapX: number;
  podGapZ: number;
  width: number;
  depth: number;
  wallHeight: number;
}

export interface WalkSurface { minX: number; maxX: number; minZ: number; maxZ: number; height: number; slopeX?: number }
export interface MovablePosition { id: string; x: number; y: number; z: number; yaw: number }
export interface MovableAction { action: "picked" | "dropped" | "blocked" | "none"; position?: MovablePosition }
interface MovableProp { id: string; root: THREE.Object3D; origin: THREE.Vector3; originRotation: THREE.Euler; radius: number; height: number; restY: number; bottomOffset: number; collider: THREE.Box3 }

const DEFAULTS: OfficeOptions = {
  podsX: 2, podsZ: 2, podGapX: 9.0, podGapZ: 8.0,
  width: 30, depth: 21, wallHeight: 7.3
};

const FLOOR = 0xfadb9d;
const FLOOR_ALT = 0xffe8b4;
const WALL = 0xfffddc;
const WALL_SHADE = 0xf3e9cf;
const SKY = 0xa2cadf;
const DESK = 0xfefae5;
const METAL = 0xc9c4bb;
const RUGS = [0xe9a9cb, 0xa8dca8, 0xa9cbe8, 0xf3d09a, 0xcdb4e8, 0xf5b8a0];
const CHAIRS = [0x8fd06a, 0xe86a92, 0x75bac3, 0xf68757, 0x9d8ce0, 0xf2c14e, 0x5fc0a8];
const NOTES = [0xf7e07a, 0xa8e6a1, 0xf7b0a1, 0xa9d9f7];
const POT = 0xe2704a;
const LEAF = 0x6dd160;
const LEAF_DARK = 0x54b84c;
const LAMP = 0xb19e8e;
const CHROME = 0x6b6a72;

export const LID_CLOSED = Math.PI / 2;
export const LID_OPEN = -0.34;

export class Office {
  private updateExitDoor = (_dt: number) => {};
  private updateTraffic = (_dt: number) => {};
  private wallClock?: { hour: THREE.Group; minute: THREE.Group };
  readonly scene = new THREE.Scene();
  readonly cameraRig = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly weather!: WeatherSystem;
  coffee!: CoffeeStation;
  readonly wallArt!: WallArtGallery;
  readonly elevator!: OfficeElevator;
  readonly worldBounds = { minX: -78, maxX: 78, minZ: -78, maxZ: 78 };
  readonly exitDoorPosition = { x: 0, z: 0 };
  readonly renderer: THREE.WebGLRenderer;
  readonly seats: Seat[] = [];
  readonly roomSeats: { x: number; z: number; y: number; yaw: number; label: string }[] = [];
  readonly breakroomSeats: { x: number; z: number; y: number; yaw: number; label: string }[] = [];
  readonly colliders: THREE.Box3[] = [];
  readonly tallColliders: THREE.Box3[] = [];
  readonly walkSurfaces: WalkSurface[] = [];
  private readonly movableProps: MovableProp[] = [];
  private readonly laptopIconTextures = new Map<string, THREE.Texture>();
  private exteriorWalkHeightAt: (x: number, z: number) => number | undefined = () => undefined;
  private exitDoorAction: (open: boolean) => void = () => {};
  private exitDoorOpen = false;
  private outdoorNight?: boolean;
  readonly bossSeat = { x: 10.6, z: 9.35, y: 3, yaw: Math.PI };
  private bossLaptopSeat?: Seat;
  bossLaptop!: Laptop;
  tvScreen!: THREE.Mesh;
  readonly watercoolerPosition = { x: 9.8, z: -9.94 };
  readonly breakroomSwitchPosition = { x: 14.78, z: -8.25, y: 1.25 };
  readonly blindControls: { id: string; label: string; x: number; z: number; y: number }[] = [];
  readonly lightRowSwitchPositions = [{ x: -14.65, z: -7.2 }, { x: -14.65, z: -6.4 }, { x: -14.65, z: -5.6 }];
  readonly stickyNotePositions: ({ x: number; z: number } | undefined)[] = [];
  private readonly stickyNoteDefaults: (WallPoint | undefined)[] = [];
  private stickyNotePreview?: THREE.Mesh;
  stickyNotes = Array<string>(13).fill("");
  lightOn = true;
  lightRows: [boolean, boolean, boolean] = [true, true, true];
  breakroomOn = true;
  blindStage = 0;
  blindStages: Record<string, number> = {};
  showDeskMarkers = true;
  readonly options: OfficeOptions;
  private desks = new Map<number, { x: number; z: number; yaw: number; laptopY?: number }>();
  private hemisphere!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;
  private keyLight!: THREE.DirectionalLight;
  private blindMaterial?: THREE.MeshLambertMaterial;
  private blindHardware = new THREE.MeshLambertMaterial({ color: 0xb7b1a4 });
  private readonly blinds = new Map<string, { cloth: THREE.Mesh; tube: THREE.Mesh; width: number; fullHeight: number; top: number; progress: number; target: number; axis: "x" | "z" }>();
  private waterCup!: THREE.Mesh;
  private waterCupTimer = 0;
  private breakroomLever!: THREE.Mesh;
  private breakroomLight!: THREE.SpotLight;
  private breakroomBulb!: THREE.Mesh;
  private lightRowLevers: THREE.Mesh[] = [];
  private stickyNoteCanvases: ({ context: CanvasRenderingContext2D; texture: THREE.CanvasTexture; mesh: THREE.Mesh } | undefined)[] = [];
  private autoDoors: { x: number; centerZ: number; panels: [THREE.Mesh, THREE.Mesh]; open: number; target: number; bounds: THREE.Box3 }[] = [];
  private doorSoundPending = false;
  private exitDoorCloseTimer = 0;
  private bulbs: THREE.Mesh[][] = [[], [], []];
  private fixtureLights: THREE.SpotLight[][] = [[], [], []];
  private lastShadowUpdate = -Infinity;
  private shadowDirty = true;
  private shadowMotion = false;
  private readonly shadowSunDirection = new THREE.Vector3();
  private heldProp: MovableProp | null = null;

  constructor(container: HTMLElement, readonly models: OfficeModels, options: Partial<OfficeOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    const { width, depth } = this.options;

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(0xf3e6cd, 38, 78);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 240);
    this.camera.position.set(0, 4, 12);
    this.scene.add(this.cameraRig);
    this.cameraRig.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local-floor");
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    const environment = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(environment, 0.04).texture;
    this.scene.environmentIntensity = 0.025;
    environment.dispose(); pmrem.dispose();
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = "scene";
    this.renderer.domElement.style.zIndex = "1";

    this.buildLights();
    this.buildFloor(width, depth);
    this.buildWalls(width, depth);
    this.buildCeiling(width, depth);
    this.buildPods();
    this.buildBossDesk();
    this.buildRooms();
    this.buildWallClock();
    this.buildWallTV();
    const exterior = buildExterior(this.scene, width, depth);
    this.colliders.push(...exterior.colliders);
    this.exteriorWalkHeightAt = exterior.walkHeightAt;
    Object.assign(this.exitDoorPosition, exterior.exitDoorPosition);
    this.exitDoorAction = exterior.setExitDoor;
    this.updateExitDoor = exterior.updateExitDoor;
    this.updateTraffic = exterior.updateTraffic;
    this.colliders.push(...buildOutdoor(this.scene));
    this.elevator = new OfficeElevator(this.scene);
    this.colliders.push(...this.elevator.colliders);
    this.walkSurfaces.push(...this.elevator.walkSurfaces);
    this.weather = new WeatherSystem(this.scene, depth);
    this.wallArt = new WallArtGallery(this.scene, width, depth);
    const loft = buildLoft(this.scene, this.models);
    this.colliders.push(...loft.colliders);
    this.walkSurfaces.push(...loft.walkSurfaces);
    this.fixtureLights[2].push(loft.light); this.bulbs[2].push(loft.bulb);
    this.setLights(true);
    this.setBreakroomLights(true);
  }

  private buildWallClock(): void {
    const clock = new THREE.Group();
    clock.position.set(3.9, 3.2, 10.315);
    clock.rotation.y = Math.PI;
    const casing = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.07, 48), surfaceMaterial(0x715d46));
    casing.rotation.x = Math.PI / 2;
    clock.add(casing);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(256, 256, 235, 0, Math.PI * 2);
    ctx.fillStyle = "#f6efdd";
    ctx.fill();
    ctx.strokeStyle = "#4a4033";
    ctx.lineWidth = 8;
    ctx.stroke();
    for (let i = 0; i < 60; i++) { const angle = i * Math.PI / 30, outer = 215, inner = i % 5 === 0 ? 180 : 201; ctx.beginPath(); ctx.moveTo(256 + Math.sin(angle) * inner, 256 - Math.cos(angle) * inner); ctx.lineTo(256 + Math.sin(angle) * outer, 256 - Math.cos(angle) * outer); ctx.lineWidth = i % 5 === 0 ? 6 : 2.5; ctx.strokeStyle = "#514638"; ctx.stroke(); }
    ctx.font = "600 37px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#352f28";
    for (let i = 1; i <= 12; i++) { const angle = i * Math.PI / 6; ctx.fillText(String(i), 256 + Math.sin(angle) * 145, 256 - Math.cos(angle) * 145); }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }));
    dial.position.z = 0.04;
    clock.add(dial);
    const hour = new THREE.Group(), minute = new THREE.Group();
    const hourHand = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.22, 0.012), surfaceMaterial(0x302b27));
    hourHand.position.y = 0.1;
    const minuteHand = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.31, 0.014), surfaceMaterial(0x302b27));
    minuteHand.position.y = 0.15;
    hour.add(hourHand);
    minute.add(minuteHand);
    hour.position.z = 0.056;
    minute.position.z = 0.075;
    clock.add(hour, minute);
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.027, 10, 8), surfaceMaterial(0x9d7950));
    pin.position.z = 0.09;
    clock.add(pin);
    this.wallClock = { hour, minute };
    this.scene.add(clock);
    this.updateWallClock();
  }

  private updateWallClock(): void {
    if (!this.wallClock) return;
    const now = this.weather?.lighting.calendar ?? new Date(), minutes = now.getMinutes() + (now.getSeconds() + now.getMilliseconds() / 1000) / 60;
    this.wallClock.minute.rotation.z = -minutes * Math.PI / 30;
    this.wallClock.hour.rotation.z = -((now.getHours() % 12) + minutes / 60) * Math.PI / 6;
  }

  private buildWallTV(): void {
    const centerY = 3.25;
    this.box(0.18, 3.95, 6.7, 0x111921, 14.75, centerY, 0, false);
    this.box(0.04, 3.78, 6.56, 0x252c31, 14.635, centerY, 0, false);
    this.tvScreen = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.6), new THREE.MeshBasicMaterial({ color: 0x05080a }));
    this.tvScreen.rotation.y = -Math.PI / 2;
    this.tvScreen.position.set(14.614, centerY, 0);
    const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshBasicMaterial({ color: 0x75c9e8 }));
    indicator.position.set(14.595, centerY - 1.88, 0);
    this.scene.add(this.tvScreen, indicator);
  }

  private buildLights(): void {
    this.hemisphere = new THREE.HemisphereLight(0xf3f8ff, 0xbda990, 0.025);
    this.ambient = new THREE.AmbientLight(0xfff4dc, 0);
    this.keyLight = new THREE.DirectionalLight(0xfff3db, 0);
    this.keyLight.visible = false; this.ambient.visible = false;
    this.keyLight.position.set(-8, 14, -6);
    this.keyLight.castShadow = false;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    Object.assign(this.keyLight.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 55 });
    this.keyLight.shadow.bias = -0.0016;
    this.keyLight.shadow.normalBias = 0.025;
    this.keyLight.shadow.radius = 4;
    this.scene.add(this.hemisphere, this.ambient, this.keyLight);
  }

  private box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, shadow = true): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), surfaceMaterial(color, color === METAL || color === CHROME ? 0.35 : 0.76, color === METAL || color === CHROME ? 0.65 : 0));
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  private buildFloor(width: number, depth: number): void {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, -depth / 2);
    shape.lineTo(width / 2, -depth / 2);
    shape.lineTo(width / 2, depth / 2);
    shape.lineTo(-width / 2, depth / 2);
    shape.closePath();
    const hole = new THREE.Path();
    const halfX = ELEVATOR_LAYOUT.width / 2, halfZ = ELEVATOR_LAYOUT.depth / 2;
    hole.moveTo(ELEVATOR_LAYOUT.x - halfX, -(ELEVATOR_LAYOUT.z + halfZ));
    hole.lineTo(ELEVATOR_LAYOUT.x - halfX, -(ELEVATOR_LAYOUT.z - halfZ));
    hole.lineTo(ELEVATOR_LAYOUT.x + halfX, -(ELEVATOR_LAYOUT.z - halfZ));
    hole.lineTo(ELEVATOR_LAYOUT.x + halfX, -(ELEVATOR_LAYOUT.z + halfZ));
    hole.closePath();
    shape.holes.push(hole);
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color: 0xe9c581 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grain = document.createElement("canvas");
    grain.width = 64;
    grain.height = 256;
    const ctx = grain.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, grain.width, grain.height);
    let seed = 13;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff);
    for (let i = 0; i < 55; i++) {
      const x = random() * grain.width;
      const y = random() * grain.height;
      ctx.strokeStyle = `rgba(143, 91, 39, ${0.025 + random() * 0.045})`;
      ctx.lineWidth = 0.4 + random() * 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + random() * 2 - 1, y + 10, x + random() * 2 - 1, y + 25, x, y + 28 + random() * 32);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(grain);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const plankWidth = width / 34;
    const plankLength = depth / 5;
    const materials = [FLOOR, FLOOR_ALT].map((color) => new THREE.MeshStandardMaterial({ color, map: texture, roughness: 0.82 }));
    const planks = new THREE.Group();
    for (let col = 0; col < 34; col++) {
      const x = -width / 2 + (col + 0.5) * plankWidth;
      const offset = (col % 3) * plankLength / 3;
      for (let start = -depth / 2 - offset; start < depth / 2; start += plankLength) {
        const low = Math.max(start, -depth / 2);
        const high = Math.min(start + plankLength, depth / 2);
        if (high <= low) continue;
        const holeX = x + plankWidth / 2 > ELEVATOR_LAYOUT.x - halfX && x - plankWidth / 2 < ELEVATOR_LAYOUT.x + halfX;
        const segments: [number, number][] = holeX && high > ELEVATOR_LAYOUT.z - halfZ && low < ELEVATOR_LAYOUT.z + halfZ ? [[low, Math.min(high, ELEVATOR_LAYOUT.z - halfZ)], [Math.max(low, ELEVATOR_LAYOUT.z + halfZ), high]] : [[low, high]];
        for (const [plankLow, plankHigh] of segments) {
          if (plankHigh - plankLow <= 0.018) continue;
          const plank = new THREE.Mesh(new THREE.PlaneGeometry(plankWidth - 0.018, plankHigh - plankLow - 0.018), materials[col % 5 === 0 ? 1 : 0]);
          plank.rotation.x = -Math.PI / 2;
          plank.position.set(x, 0.002, (plankLow + plankHigh) / 2);
          plank.receiveShadow = true;
          planks.add(plank);
        }
      }
    }
    mergeStaticMeshes(planks); this.scene.add(planks);
  }

  private buildRollerBlind(id: string, wall: WallId, center: number, width: number, bottom: number, top: number, wallAxis: number, axis: "x" | "z"): void {
    if (!this.blindMaterial) {
      const fabric = document.createElement("canvas"); fabric.width = 64; fabric.height = 128;
      const context = fabric.getContext("2d")!; context.fillStyle = "#e9dfcc"; context.fillRect(0, 0, fabric.width, fabric.height);
      for (let y = 8; y < fabric.height; y += 14) { context.fillStyle = "#d1c3aa"; context.fillRect(0, y, fabric.width, 2); context.fillStyle = "#f5eddb"; context.fillRect(0, y + 2, fabric.width, 2); }
      const texture = new THREE.CanvasTexture(fabric); texture.colorSpace = THREE.SRGBColorSpace;
      this.blindMaterial = new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide });
    }
    const number = this.blindControls.filter((control) => control.id.startsWith(`${wall}-`)).length + 1;
    const wallLabel = wall === "north" ? "Front" : wall === "south" ? "Back" : wall === "east" ? "Right" : "Left";
    const span = Math.max(0.4, width), fullHeight = top - bottom, isFront = wall === "north" || wall === "west", offset = isFront ? 0.23 : -0.23;
    const shade = new THREE.Mesh(new THREE.PlaneGeometry(span, fullHeight), this.blindMaterial);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, span + 0.08, 12), this.blindHardware);
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, fullHeight * 0.7, 6), this.blindHardware);
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), this.blindHardware);
    const inX = axis === "z" ? wallAxis + offset : undefined, inZ = axis === "x" ? wallAxis + offset : undefined;
    if (axis === "x") {
      shade.position.set(center, top, inZ!); tube.rotation.z = Math.PI / 2; tube.position.set(center, top + 0.06, inZ!);
      const chainX = center + span / 2 - 0.1; chain.position.set(chainX, top - fullHeight * 0.35, inZ!); handle.position.set(chainX, bottom + fullHeight * 0.24, inZ!);
      this.blindControls.push({ id, label: `${wallLabel} window ${number}`, x: chainX, z: inZ! + (wall === "north" ? 0.52 : -0.52), y: 1.4 });
    } else {
      shade.rotation.y = Math.PI / 2; shade.position.set(inX!, top, center); tube.rotation.x = Math.PI / 2; tube.position.set(inX!, top + 0.06, center);
      const chainZ = center + span / 2 - 0.1; chain.position.set(inX!, top - fullHeight * 0.35, chainZ); handle.position.set(inX!, bottom + fullHeight * 0.24, chainZ);
      this.blindControls.push({ id, label: `${wallLabel} window ${number}`, x: inX! + (wall === "east" ? -0.52 : 0.52), z: chainZ, y: 1.4 });
    }
    shade.visible = false; shade.renderOrder = 1; shade.castShadow = true; tube.castShadow = false; chain.castShadow = false; handle.castShadow = false;
    this.scene.add(tube, shade, chain, handle);
    this.blinds.set(id, { cloth: shade, tube, width: span, fullHeight, top, progress: 0, target: 0, axis });
  }

  aimWall(ray: THREE.Ray): WallPoint | null {
    const hit = aimAtRoomWall(ray, this.options.width, this.options.depth), point = hit ? fitWallPoint(hit, 0.72, 0.8, this.options.width, this.options.depth) : null;
    return point && !this.wallArt.overlaps(point, 0.72, 0.8) ? point : null;
  }
  setWallArt(items: readonly WallArtPlacement[]): void { this.wallArt.sync(items); }

  private buildWalls(width: number, depth: number): void {
    const h = this.options.wallHeight;
    const windowWall = (wallId: WallId, z: number, openings: { min: number; max: number }[]) => {
      const bottom = 1.05, top = Math.min(6.65, h - 0.55), glassHeight = top - bottom;
      const wallPart = (x0: number, x1: number, y0: number, y1: number) => {
        if (x1 <= x0 || y1 <= y0) return;
        const wall = this.box(x1 - x0, y1 - y0, 0.3, WALL, (x0 + x1) / 2, (y0 + y1) / 2, z);
        const bounds = new THREE.Box3().setFromObject(wall).expandByScalar(0.04);
        this.colliders.push(bounds);
        this.tallColliders.push(bounds);
      };
      let cursor = -width / 2;
      for (const [openingIndex, opening] of openings.entries()) {
        const min = THREE.MathUtils.clamp(opening.min, cursor, width / 2), max = THREE.MathUtils.clamp(opening.max, min, width / 2);
        wallPart(cursor, min, 0, h);
        wallPart(min, max, 0, bottom);
        wallPart(min, max, top, h);
        const panes = Math.max(1, Math.ceil((max - min) / 3.6));
        for (let i = 0; i < panes; i++) {
          const x0 = min + (max - min) * i / panes, x1 = min + (max - min) * (i + 1) / panes;
          if (i) this.box(0.075, glassHeight, 0.12, METAL, x0, bottom + glassHeight / 2, z, false);
          const glass = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 0.08, glassHeight - 0.08), new THREE.MeshPhysicalMaterial({ color: 0xb9dced, transparent: true, opacity: 0.12, roughness: 0.12, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }));
          glass.position.set((x0 + x1) / 2, bottom + glassHeight / 2, z + (z < 0 ? 0.16 : -0.16));
          this.scene.add(glass);
          this.buildRollerBlind(`${wallId}-${openingIndex}-${i}`, wallId, (x0 + x1) / 2, x1 - x0 - 0.08, bottom, top, z, "x");
          const bounds = new THREE.Box3(new THREE.Vector3(x0, bottom, z - 0.05), new THREE.Vector3(x1, top, z + 0.05));
          this.colliders.push(bounds);
          this.tallColliders.push(bounds);
        }
        this.box(max - min, 0.075, 0.12, METAL, (min + max) / 2, bottom, z, false);
        this.box(max - min, 0.075, 0.12, METAL, (min + max) / 2, top, z, false);
        cursor = max;
      }
      wallPart(cursor, width / 2, 0, h);
      const skirt = this.box(width, 0.16, 0.34, WALL_SHADE, 0, 0.08, z, false);
      skirt.receiveShadow = true;
    };
    const sideWindowWall = (wallId: WallId, x: number, openings: { min: number; max: number }[]) => {
      const bottom = 1.05, top = Math.min(6.65, h - 0.55), glassHeight = top - bottom;
      const wallPart = (z0: number, z1: number, y0: number, y1: number) => {
        if (z1 <= z0 || y1 <= y0) return;
        const wall = this.box(0.3, y1 - y0, z1 - z0, WALL, x, (y0 + y1) / 2, (z0 + z1) / 2);
        const bounds = new THREE.Box3().setFromObject(wall).expandByScalar(0.04);
        this.colliders.push(bounds);
        this.tallColliders.push(bounds);
      };
      let cursor = -depth / 2;
      for (const [openingIndex, opening] of openings.entries()) {
        const min = THREE.MathUtils.clamp(opening.min, cursor, depth / 2), max = THREE.MathUtils.clamp(opening.max, min, depth / 2);
        wallPart(cursor, min, 0, h);
        wallPart(min, max, 0, bottom);
        wallPart(min, max, top, h);
        const panes = Math.max(1, Math.ceil((max - min) / 3.6));
        for (let i = 0; i < panes; i++) {
          const z0 = min + (max - min) * i / panes, z1 = min + (max - min) * (i + 1) / panes;
          if (i) this.box(0.12, glassHeight, 0.075, METAL, x, bottom + glassHeight / 2, z0, false);
          const glass = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0 - 0.08, glassHeight - 0.08), new THREE.MeshPhysicalMaterial({ color: 0xb9dced, transparent: true, opacity: 0.12, roughness: 0.12, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }));
          glass.rotation.y = Math.PI / 2;
          glass.position.set(x + (x > 0 ? -0.16 : 0.16), bottom + glassHeight / 2, (z0 + z1) / 2);
          this.scene.add(glass);
          this.buildRollerBlind(`${wallId}-${openingIndex}-${i}`, wallId, (z0 + z1) / 2, z1 - z0 - 0.08, bottom, top, x, "z");
          const bounds = new THREE.Box3(new THREE.Vector3(x - 0.05, bottom, z0), new THREE.Vector3(x + 0.05, top, z1));
          this.colliders.push(bounds);
          this.tallColliders.push(bounds);
        }
        this.box(0.12, 0.075, max - min, METAL, x, bottom, (min + max) / 2, false);
        this.box(0.12, 0.075, max - min, METAL, x, top, (min + max) / 2, false);
        cursor = max;
      }
      wallPart(cursor, depth / 2, 0, h);
    };
    for (const [x, z, span, along] of [
      [0, -depth / 2, width, true], [0, depth / 2, width, true],
      [-width / 2, 0, depth, false], [width / 2, 0, depth, false]
    ] as [number, number, number, boolean][]) {
      if (along && z < 0) { windowWall("north", z, [{ min: -14, max: 14 }]); continue; }
      if (along && z > 0) { windowWall("south", z, [{ min: -12, max: -7.5 }, { min: -4.5, max: 0 }, { min: 7.8, max: 14.5 }]); continue; }
      if (!along && x > 0) { sideWindowWall("east", x, [{ min: 6, max: depth / 2 - 0.2 }]); continue; }
      if (!along && x < 0) {
        const doorWidth = EXIT_DOOR_OPENING_WIDTH;
        const doorHeight = 2.4;
        const doorZ = 6.5;
        const lower = doorZ - doorWidth / 2;
        const upper = doorZ + doorWidth / 2;
        const segment = (centerZ: number, segmentDepth: number) => {
          const wall = this.box(0.3, h, segmentDepth, WALL, x, h / 2, centerZ, false);
          this.box(0.34, 0.16, segmentDepth, WALL_SHADE, x, 0.08, centerZ, false);
          const bounds = new THREE.Box3().setFromObject(wall).expandByScalar(0.12);
          this.colliders.push(bounds);
          this.tallColliders.push(bounds);
        };
        segment((-depth / 2 + lower) / 2, lower + depth / 2);
        segment((upper + depth / 2) / 2, depth / 2 - upper);
        const header = this.box(0.3, h - doorHeight, doorWidth, WALL, x, doorHeight + (h - doorHeight) / 2, doorZ, false);
        const headerBounds = new THREE.Box3().setFromObject(header).expandByScalar(0.12);
        this.colliders.push(headerBounds);
        this.tallColliders.push(headerBounds);
        for (const edge of [lower, upper]) this.box(0.1, doorHeight, 0.1, WALL_SHADE, x, doorHeight / 2, edge, false);
        continue;
      }
      const wall = this.box(along ? span : 0.3, h, along ? 0.3 : span, along && z < 0 ? 0xd8c6ad : WALL, x, h / 2, z, false);
      const skirt = this.box(along ? span : 0.34, 0.16, along ? 0.34 : span, WALL_SHADE, x, 0.08, z, false);
      skirt.receiveShadow = true;
      this.colliders.push(new THREE.Box3().setFromObject(wall).expandByScalar(0.12));
      this.tallColliders.push(new THREE.Box3().setFromObject(wall).expandByScalar(0.12));
    }

    this.setBlinds({}, 0);

    this.buildWhiteboard(width);
    this.buildNotes();
    this.buildBackNotes();
  }

  readonly whiteboardAnchor = { x: -14.6, y: 2.3, z: -2, yaw: Math.PI / 2 };

  private buildWhiteboard(width: number): void {
    const x = -width / 2 + 0.25, z = this.whiteboardAnchor.z;
    const frame = this.box(0.1, 2.7, 5.8, LAMP, x, 2.3, z, false);
    this.colliders.push(new THREE.Box3().setFromObject(frame).expandByScalar(0.06));
    this.tallColliders.push(new THREE.Box3().setFromObject(frame).expandByScalar(0.06));
    this.whiteboardAnchor.x = x + 0.17;
    this.whiteboardAnchor.yaw = Math.PI / 2;
    this.box(0.12, 0.07, 5.4, METAL, x + 0.08, 0.86, z, false);
  }

  private buildNotes(): void {
    for (let i = 0; i < 10; i++) this.stickyNoteDefaults[i] = { wall: "south", u: [0.65, 1.95, 3.25, 4.55, 5.85][i % 5], y: 2.15 + Math.floor(i / 5) * 1.15 };
  }

  private buildBackNotes(): void {
    for (let i = 0; i < 3; i++) this.stickyNoteDefaults[10 + i] = { wall: "south", u: 1.4 + i * 1.85, y: 4.35 };
  }

  private drawStickyNote(index: number, value: string): void {
    let text = value, strokes: { color: string; points: [number, number][] }[] = [];
    let point = this.stickyNoteDefaults[index];
    try {
      const data = JSON.parse(value);
      if (typeof data.text === "string" && Array.isArray(data.strokes)) {
        text = data.text; strokes = data.strokes;
        if (data.position && ["north", "south", "east", "west"].includes(data.position.wall) && Number.isFinite(data.position.u) && Number.isFinite(data.position.y)) point = data.position as WallPoint;
      }
    } catch {}
    const visible = !!text.trim() || strokes.length > 0;
    const existing = this.stickyNoteCanvases[index];
    if (!visible || !point) {
      if (existing) { this.scene.remove(existing.mesh); existing.mesh.geometry.dispose(); (existing.mesh.material as THREE.Material).dispose(); existing.texture.dispose(); this.stickyNoteCanvases[index] = undefined; }
      this.stickyNotePositions[index] = undefined;
      return;
    }
    const card = existing ?? (() => {
      const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 288;
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.8), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
      this.scene.add(mesh);
      const created = { context: canvas.getContext("2d")!, texture, mesh }; this.stickyNoteCanvases[index] = created;
      return created;
    })();
    const { context, texture, mesh } = card;
    const pose = wallPose(point.wall, point.u, point.y, this.options.width, this.options.depth, 0.22);
    mesh.position.set(pose.x, pose.y, pose.z); mesh.rotation.y = pose.rotY;
    this.stickyNotePositions[index] = { x: pose.x, z: pose.z };
    context.clearRect(0, 0, 256, 288);
    context.fillStyle = `#${NOTES[index % NOTES.length].toString(16).padStart(6, "0")}`;
    context.fillRect(0, 0, 256, 288);
    context.fillStyle = "rgba(255,255,255,.35)";
    context.fillRect(20, 12, 216, 9);
    context.fillStyle = "#4b4032";
    context.font = "bold 24px Segoe UI, sans-serif";
    context.textBaseline = "top";
    if (text.trim()) {
      const lines = text.split(/\r?\n/).flatMap((line) => line.match(/.{1,17}/g) ?? [""]).slice(0, 9);
      lines.forEach((line, i) => context.fillText(line, 22, 38 + i * 27));
    }
    for (const stroke of strokes) {
      if (!/^#[\da-f]{6}$/i.test(stroke.color) || !Array.isArray(stroke.points)) continue;
      context.strokeStyle = stroke.color;
      context.lineWidth = 3;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      stroke.points.slice(0, 200).forEach(([x, y], i) => i ? context.lineTo(x * 256 / 1000, y * 288 / 1000) : context.moveTo(x * 256 / 1000, y * 288 / 1000));
      context.stroke();
    }
    texture.needsUpdate = true;
  }

  setStickyNotes(notes: readonly string[]): void {
    this.stickyNotes = Array.from({ length: 13 }, (_, i) => notes[i] ?? "");
    this.stickyNotes.forEach((note, i) => this.drawStickyNote(i, note));
  }

  setStickyNotePreview(point: WallPoint | null): void {
    if (!point) { if (this.stickyNotePreview) this.stickyNotePreview.visible = false; return; }
    if (!this.stickyNotePreview) {
      this.stickyNotePreview = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.8), new THREE.MeshBasicMaterial({ color: 0xf7df6e, transparent: true, opacity: 0.52, depthWrite: false, side: THREE.DoubleSide }));
      this.scene.add(this.stickyNotePreview);
    }
    const pose = wallPose(point.wall, point.u, point.y, this.options.width, this.options.depth, 0.22);
    this.stickyNotePreview.position.set(pose.x, pose.y, pose.z); this.stickyNotePreview.rotation.y = pose.rotY; this.stickyNotePreview.visible = true;
  }

  private buildCeiling(width: number, depth: number): void {
    const h = this.options.wallHeight;
    this.box(width, 0.2, depth, 0xfdf8ee, 0, h + 0.1, 0);
    const shadeY = 4.95;
    const cordTop = h - 0.08;
    const cordBottom = shadeY + 0.25;
    const cordLength = cordTop - cordBottom;
    const shadeMaterial = surfaceMaterial(0xd8c49b, 0.42, 0.45).clone(), lampMetal = surfaceMaterial(0x68645a, 0.38, 0.65);
    shadeMaterial.side = THREE.DoubleSide;
    const shadeProfile = [[0.52, -0.25], [0.515, -0.22], [0.46, -0.185], [0.365, -0.12], [0.25, -0.015], [0.15, 0.095], [0.09, 0.185], [0.075, 0.25]].map(([radius, y]) => new THREE.Vector2(radius, y));
    const shadeGeometry = new THREE.LatheGeometry(shadeProfile, 48), rimGeometry = new THREE.TorusGeometry(0.516, 0.012, 8, 48);
    for (let row = 0; row < 3; row++) {
      const z = [-5.8, 0, 4.8][row];
      for (let i = -2; i <= 2; i++) {
        if (row === 1 && i === 2) continue;
        const x = i * 6.4;
        const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, cordLength, 10), surfaceMaterial(LAMP, 0.7));
        cord.position.set(x, (cordTop + cordBottom) / 2, z);
        cord.receiveShadow = false;
        const shade = new THREE.Mesh(shadeGeometry, shadeMaterial);
        shade.position.set(x, shadeY, z);
        shade.castShadow = false;
        const rim = new THREE.Mesh(rimGeometry, lampMetal); rim.rotation.x = Math.PI / 2; rim.position.set(x, shadeY - 0.245, z);
        const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.074, 0.074, 0.09, 24), lampMetal); socket.position.set(x, cordBottom - 0.012, z);
        const ceilingRose = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.035, 24), lampMetal); ceilingRose.position.set(x, h - 0.025, z);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 16), new THREE.MeshStandardMaterial({ color: 0xf5f1e8, emissive: 0xfff3c4, emissiveIntensity: 1, roughness: 0.35 }));
        bulb.position.set(x, shadeY - 0.2, z);
        if (x > 7.8 && z > 5.9) continue;
        const light = new THREE.SpotLight(0xffe5ad, 8, 14, 1.05, 0.7, 2);
        light.position.copy(bulb.position);
        light.target.position.set(x, 0, z); light.castShadow = this.fixtureLights[row].length === 1; light.shadow.mapSize.set(1024, 1024); light.shadow.normalBias = 0.018; light.shadow.bias = -0.00012;
        this.bulbs[row].push(bulb);
        this.fixtureLights[row].push(light);
        this.scene.add(cord, shade, rim, socket, ceilingRose, bulb, light, light.target);
      }
    }
    this.box(0.12, 0.62, 1.9, DESK, -14.79, 1.26, -6.4, false);
    for (const switchPosition of this.lightRowSwitchPositions) this.lightRowLevers.push(this.box(0.06, 0.15, 0.055, 0x958a75, -14.66, 1.26, switchPosition.z, false));
  }

  setLights(on: boolean): void {
    this.setLightRows([on, on, on]);
  }

  setLightRows(rows: readonly boolean[]): void {
    this.lightRows = [rows[0] ?? true, rows[1] ?? true, rows[2] ?? true];
    this.lightOn = this.lightRows.some(Boolean);
    this.ambient.intensity = 0;
    this.updateBlindLighting();
    for (let row = 0; row < this.lightRows.length; row++) {
      const on = this.lightRows[row];
      for (const bulb of this.bulbs[row]) (bulb.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 1 : 0;
      for (const light of this.fixtureLights[row]) { light.intensity = on ? Number(light.userData.onIntensity ?? 8) : 0; light.visible = on; }
      if (this.lightRowLevers[row]) this.lightRowLevers[row].rotation.z = on ? -0.35 : 0.35;
    }
    this.invalidateShadows();
  }

  setBreakroomLights(on: boolean): void {
    this.breakroomOn = on;
    this.breakroomLight.intensity = on ? 4 : 0;
    this.breakroomLight.visible = on; this.invalidateShadows();
    (this.breakroomBulb.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 1 : 0;
    this.breakroomLever.rotation.z = on ? -0.35 : 0.35;
  }

  setBlinds(stages: Record<string, number>, legacyStage = 0): void {
    this.blindStages = {};
    this.blindStage = THREE.MathUtils.clamp(Math.trunc(legacyStage), 0, 2);
    for (const [id, blind] of this.blinds) {
      const stage = THREE.MathUtils.clamp(Math.trunc(stages?.[id] ?? this.blindStage), 0, 2);
      this.blindStages[id] = stage;
      blind.target = stage / 2;
    }
    this.updateBlindLighting();
  }

  private updateBlinds(dt: number): void {
    for (const blind of this.blinds.values()) {
      blind.progress += (blind.target - blind.progress) * (1 - Math.exp(-dt * 7));
      if (Math.abs(blind.target - blind.progress) > 0.001) this.shadowDirty = true;
      if (Math.abs(blind.target - blind.progress) < 0.001) blind.progress = blind.target;
      blind.cloth.scale.y = Math.max(0.001, blind.progress);
      blind.cloth.position.y = blind.top - blind.fullHeight * blind.progress / 2;
      blind.cloth.visible = blind.progress > 0.005;
    }
    this.updateBlindLighting();
  }

  private updateBlindLighting(): void {
    let sum = 0;
    for (const blind of this.blinds.values()) sum += blind.progress;
    const openness = 1 - (this.blinds.size ? sum / this.blinds.size : 0) * 0.94, daylight = (this.weather?.lighting.diffuse ?? 0) * openness, lamps = (Number(this.lightRows[0]) + Number(this.lightRows[1]) + Number(this.lightRows[2])) / 3;
    this.keyLight.intensity = 0;
    this.hemisphere.intensity = daylight * 0.045 + lamps * 0.015;
    if (this.weather) this.hemisphere.color.copy(this.weather.lighting.skyColor);
    this.scene.environmentIntensity = daylight * 0.04 + lamps * 0.025;
  }

  useWatercooler(): void {
    this.waterCup.visible = true;
    window.clearTimeout(this.waterCupTimer);
    this.waterCupTimer = window.setTimeout(() => (this.waterCup.visible = false), 2300);
  }

  setBossLaptopOpen(open: boolean): void { if (this.bossLaptopSeat) this.setSeatLaptopOpen(this.bossLaptopSeat, open); }
  setSeatLaptopOpen(seat: Seat, open: boolean): void { seat.lidTarget = open ? LID_OPEN : LID_CLOSED; }

  private updateLaptopLid(seat: Seat, dt: number): void {
    if (!seat.laptop) return;
    if (Math.abs(seat.lid - seat.lidTarget) >= 0.001) { seat.lid += (seat.lidTarget - seat.lid) * Math.min(1, 7 * dt); this.invalidateShadows(); }
    seat.laptop.pivot.rotation.x = seat.lid;
    seat.laptop.keyboard.visible = seat.lid < 0.55;
  }

  private addChairColliders(x: number, z: number, yaw: number): void {
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const backX = x + sin * 0.22, backZ = z + cos * 0.22;
    const backHalfX = Math.abs(cos) * 0.22 + Math.abs(sin) * 0.08;
    const backHalfZ = Math.abs(sin) * 0.22 + Math.abs(cos) * 0.08;
    this.colliders.push(
      new THREE.Box3(new THREE.Vector3(x - 0.24, 0, z - 0.24), new THREE.Vector3(x + 0.24, 0.47, z + 0.24)),
      new THREE.Box3(new THREE.Vector3(x - 0.07, 0, z - 0.07), new THREE.Vector3(x + 0.07, 0.48, z + 0.07)),
      new THREE.Box3(new THREE.Vector3(backX - backHalfX, 0.42, backZ - backHalfZ), new THREE.Vector3(backX + backHalfX, 0.95, backZ + backHalfZ))
    );
    this.walkSurfaces.push({ minX: x - 0.22, maxX: x + 0.22, minZ: z - 0.22, maxZ: z + 0.22, height: 0.48 });
  }

  isWithinWorldBounds(x: number, z: number): boolean { return x >= this.worldBounds.minX && x <= this.worldBounds.maxX && z >= this.worldBounds.minZ && z <= this.worldBounds.maxZ; }
  isNearExitDoor(x: number, z: number): boolean { return Math.hypot(x - this.exitDoorPosition.x, z - this.exitDoorPosition.z) < 1.35; }
  toggleExitDoor(): boolean { this.setExitDoorOpen(!this.exitDoorOpen); return this.exitDoorOpen; }
  setExitDoorOpen(open: boolean): void {
    if (open !== this.exitDoorOpen) this.doorSoundPending = true;
    this.exitDoorOpen = open;
    this.exitDoorCloseTimer = open ? 6 : 0;
    this.exitDoorAction(open);
    this.invalidateShadows();
  }
  consumeDoorSound(): boolean { const pending = this.doorSoundPending; this.doorSoundPending = false; return pending; }

  walkSurfaceAt(x: number, z: number, feetY = 0): number {
    const interior = Math.abs(x) <= this.options.width / 2 && Math.abs(z) <= this.options.depth / 2;
    let height = this.elevator?.surfaceAt(x, z) ?? (interior ? (feetY < -1.2 ? -3.6 : 0) : this.exteriorWalkHeightAt(x, z) ?? -3.6);
    for (const surface of this.walkSurfaces) { const surfaceHeight = surface.height + (surface.slopeX ?? 0) * (x - surface.minX); if (surfaceHeight >= feetY - 0.27 && surfaceHeight <= feetY + 1.02 && x >= surface.minX && x <= surface.maxX && z >= surface.minZ && z <= surface.maxZ) height = Math.max(height, surfaceHeight); }
    for (const box of this.colliders) { const surfaceHeight = box.max.y, thickness = box.max.y - box.min.y; if (thickness < 0.18 || thickness > 0.27 || surfaceHeight < feetY - 0.27 || surfaceHeight > feetY + 1.02 || x + 0.24 <= box.min.x || x - 0.24 >= box.max.x || z + 0.24 <= box.min.z || z - 0.24 >= box.max.z) continue; height = Math.max(height, surfaceHeight); }
    return height;
  }

  findExitRoute(startX: number, startZ: number): Array<{ x: number; z: number }> {
    const goalX = -this.options.width / 2 + 0.6, goalZ = 6.5, route = this.findAgentRoute(startX, startZ, goalX, goalZ);
    if (!route.length) return [];
    const stairX = -this.options.width / 2 - 3;
    route.push({ x: stairX, z: 6.5 });
    route.push({ x: stairX, z: 7.5 });
    return route;
  }

  findAgentRoute(startX: number, startZ: number, targetX: number, targetZ: number, feetY = 0): Array<{ x: number; z: number }> {
    const cell = 0.35, radius = 0.29, minX = -this.options.width / 2 + radius, maxX = this.options.width / 2 - radius, minZ = -this.options.depth / 2 + radius, maxZ = this.options.depth / 2 - radius;
    if (startX < minX || startX > maxX || startZ < minZ || startZ > maxZ || targetX < minX || targetX > maxX || targetZ < minZ || targetZ > maxZ) return [];
    const columns = Math.floor((maxX - minX) / cell) + 1, rows = Math.floor((maxZ - minZ) / cell) + 1, key = (x: number, z: number) => z * columns + x, px = (x: number) => minX + x * cell, pz = (z: number) => minZ + z * cell;
    const start = { x: Math.round((startX - minX) / cell), z: Math.round((startZ - minZ) / cell) }, goal = { x: Math.round((targetX - minX) / cell), z: Math.round((targetZ - minZ) / cell) }, startKey = key(start.x, start.z), goalKey = key(goal.x, goal.z);
    const obstacles = this.colliders.filter((box) => box.max.y > feetY + 0.15 && box.min.y < feetY + 1.55), overlap = (x: number, z: number, box: THREE.Box3) => Math.max(0, Math.min(x + radius, box.max.x) - Math.max(x - radius, box.min.x)) * Math.max(0, Math.min(z + radius, box.max.z) - Math.max(z - radius, box.min.z));
    const startOverlaps = new Map(obstacles.map((box) => [box, overlap(startX, startZ, box)] as const).filter(([, area]) => area > 0)), goalOverlaps = new Set(obstacles.filter((box) => overlap(targetX, targetZ, box) > 0));
    const blocked = (x: number, z: number) => {
      const worldX = px(x), worldZ = pz(z);
      if (key(x, z) !== startKey && key(x, z) !== goalKey && Math.abs(this.walkSurfaceAt(worldX, worldZ, feetY) - feetY) > 0.27) return true;
      return obstacles.some((box) => {
        const area = overlap(worldX, worldZ, box);
        if (!area) return false;
        if (startOverlaps.has(box) && Math.hypot(worldX - startX, worldZ - startZ) < 0.75 && area <= startOverlaps.get(box)! + 0.00001) return false;
        if (goalOverlaps.has(box) && Math.hypot(worldX - targetX, worldZ - targetZ) < 0.45) return false;
        return true;
      });
    };
    const queue = [startKey], previous = new Map<number, number>(), visited = new Set([startKey]), directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    for (let cursor = 0; cursor < queue.length && !visited.has(goalKey); cursor++) {
      const current = queue[cursor], x = current % columns, z = Math.floor(current / columns);
      for (const [dx, dz] of directions) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= columns || nz < 0 || nz >= rows || blocked(nx, nz)) continue;
        const next = key(nx, nz);
        if (visited.has(next)) continue;
        visited.add(next); previous.set(next, current); queue.push(next);
      }
    }
    if (!visited.has(goalKey)) return [];
    const cells: number[] = [];
    for (let at = goalKey; at !== startKey; at = previous.get(at)!) cells.push(at);
    cells.reverse();
    const route: Array<{ x: number; z: number }> = [];
    let lastDirection = "";
    for (let i = 0; i < cells.length; i++) {
      const at = cells[i], next = cells[i + 1], direction = next === undefined ? "end" : `${Math.sign(next % columns - at % columns)},${Math.sign(Math.floor(next / columns) - Math.floor(at / columns))}`;
      if (direction !== lastDirection || direction === "end") route.push({ x: px(at % columns), z: pz(Math.floor(at / columns)) });
      lastDirection = direction;
    }
    if (route.length) route[route.length - 1] = { x: targetX, z: targetZ }; else route.push({ x: targetX, z: targetZ });
    return route;
  }

  canAgentMove(fromX: number, fromZ: number, toX: number, toZ: number, feetY: number, targetX: number, targetZ: number): boolean {
    const radius = 0.29, height = 1.55, overlap = (x: number, z: number, box: THREE.Box3) => Math.max(0, Math.min(x + radius, box.max.x) - Math.max(x - radius, box.min.x)) * Math.max(0, Math.min(z + radius, box.max.z) - Math.max(z - radius, box.min.z)), atGoal = Math.hypot(toX - targetX, toZ - targetZ) < 0.08;
    for (const box of this.colliders) {
      if (box.max.y <= feetY + 0.08 || box.min.y >= feetY + height) continue;
      const nextOverlap = overlap(toX, toZ, box);
      if (!nextOverlap || atGoal && overlap(targetX, targetZ, box)) continue;
      const currentOverlap = overlap(fromX, fromZ, box);
      if (currentOverlap && nextOverlap <= currentOverlap + 0.00001) continue;
      return false;
    }
    return true;
  }

  findOfficeReturnRoute(targetX: number, targetZ: number): { spawn: { x: number; z: number }; route: Array<{ x: number; z: number }> } {
    const exitRoute = this.findExitRoute(targetX, targetZ);
    if (!exitRoute.length) return { spawn: { x: targetX, z: targetZ }, route: [] };
    const landing = exitRoute.at(-1)!;
    let bottomZ = landing.z;
    while (bottomZ < this.worldBounds.maxZ && this.walkSurfaceAt(landing.x, bottomZ, -3.6) > -3.4) bottomZ += 0.15;
    const route: Array<{ x: number; z: number }> = [];
    for (let z = bottomZ - 0.3; z > landing.z + 0.001; z -= 0.3) route.push({ x: landing.x, z });
    route.push(landing, ...exitRoute.slice(0, -1).reverse(), { x: targetX, z: targetZ });
    return { spawn: { x: landing.x, z: bottomZ }, route };
  }

  registerMovable(root: THREE.Object3D, radius: number, height: number, restY = height / 2, bottomOffset = -height / 2, id = `prop-${this.movableProps.length + 1}`): void {
    const prop = { id, root, origin: root.position.clone(), originRotation: root.rotation.clone(), radius, height, restY, bottomOffset, collider: new THREE.Box3() };
    this.movableProps.push(prop);
    this.updatePropCollider(prop);
    this.colliders.push(prop.collider);
  }

  get hasHeldObject(): boolean { return this.heldProp !== null; }

  heldObjectPosition(): MovablePosition | undefined {
    const prop = this.heldProp;
    return prop ? { id: prop.id, x: prop.root.position.x, y: prop.root.position.y, z: prop.root.position.z, yaw: prop.root.rotation.y } : undefined;
  }

  hasMovableNear(x: number, z: number): boolean {
    return this.movableProps.some((prop) => prop !== this.heldProp && Math.hypot(prop.root.position.x - x, prop.root.position.z - z) < 1.2);
  }

  toggleHeldObject(x: number, z: number): MovableAction {
    if (this.heldProp) {
      const prop = this.heldProp;
      const dropBounds = new THREE.Box3(
        new THREE.Vector3(prop.root.position.x - prop.radius, prop.restY + prop.bottomOffset, prop.root.position.z - prop.radius),
        new THREE.Vector3(prop.root.position.x + prop.radius, prop.restY + prop.bottomOffset + prop.height, prop.root.position.z + prop.radius)
      );
      if (this.colliders.some((box) => box.intersectsBox(dropBounds))) return { action: "blocked" };
      prop.root.position.y = prop.restY;
      this.updatePropCollider(prop);
      this.colliders.push(prop.collider);
      this.heldProp = null;
      return { action: "dropped", position: { id: prop.id, x: prop.root.position.x, y: prop.root.position.y, z: prop.root.position.z, yaw: prop.root.rotation.y } };
    }
    const prop = this.movableProps.filter((item) => item.root.position.y < 1.5)
      .sort((a, b) => Math.hypot(a.root.position.x - x, a.root.position.z - z) - Math.hypot(b.root.position.x - x, b.root.position.z - z))
      .find((item) => Math.hypot(item.root.position.x - x, item.root.position.z - z) < 1.2);
    if (!prop) return { action: "none" };
    const colliderIndex = this.colliders.indexOf(prop.collider);
    if (colliderIndex >= 0) this.colliders.splice(colliderIndex, 1);
    this.heldProp = prop;
    return { action: "picked" };
  }

  moveHeldObject(x: number, z: number, facing: number): void {
    if (!this.heldProp) return;
    const prop = this.heldProp;
    const nextX = x + Math.sin(facing) * 0.72;
    const nextZ = z + Math.cos(facing) * 0.72;
    const bottom = 0.85 + prop.bottomOffset;
    const bounds = new THREE.Box3(new THREE.Vector3(nextX - prop.radius, bottom, nextZ - prop.radius), new THREE.Vector3(nextX + prop.radius, bottom + prop.height, nextZ + prop.radius));
    if (this.colliders.some((box) => box.intersectsBox(bounds))) return;
    prop.root.position.set(nextX, 0.85, nextZ);
    prop.root.rotation.y = facing;
  }

  applyPropPosition(position: MovablePosition): void {
    const prop = this.movableProps.find((item) => item.id === position.id);
    if (!prop || prop === this.heldProp) return;
    prop.root.position.set(position.x, position.y, position.z);
    prop.root.rotation.y = position.yaw;
    this.updatePropCollider(prop);
    this.invalidateShadows();
  }

  applyPropSnapshot(positions: MovablePosition[]): void {
    this.resetMovableObjects();
    for (const position of positions) this.applyPropPosition(position);
  }

  resetMovableObjects(): void {
    this.heldProp = null;
    this.invalidateShadows();
    for (const prop of this.movableProps) {
      prop.root.position.copy(prop.origin);
      prop.root.rotation.copy(prop.originRotation);
      this.updatePropCollider(prop);
      if (!this.colliders.includes(prop.collider)) this.colliders.push(prop.collider);
    }
  }

  private updatePropCollider(prop: MovableProp): void {
    const minY = Math.max(0, prop.root.position.y + prop.bottomOffset);
    prop.collider.min.set(prop.root.position.x - prop.radius, minY, prop.root.position.z - prop.radius);
    prop.collider.max.set(prop.root.position.x + prop.radius, minY + prop.height, prop.root.position.z + prop.radius);
  }

  private plant(x: number, z: number, scale: number, baseY = 0, id?: string): void {
    const countertop = baseY > 0, species = countertop ? "succulent" : x < 0 ? z < 4 ? "monstera" : "snake_plant" : "ficus";
    const plant = this.models.create("plants", species, { height: (countertop ? 0.44 : 1.2) * scale }, { Pot: POT, Glaze: POT, Leaf: LEAF, LeafDark: LEAF_DARK });
    plant.position.set(x, baseY, z);
    this.scene.add(plant);
    this.registerMovable(plant, (countertop ? 0.23 : 0.48) * scale, (countertop ? 0.44 : 1.2) * scale, 0, 0, id);
  }

  private buildPods(): void {
    const { podsX, podsZ, podGapX, podGapZ } = this.options;
    const originX = -((podsX - 1) * podGapX) / 2 - podGapX / 2;
    const originZ = -((podsZ - 1) * podGapZ) / 2;
    const oldSeatIds = [0, 1, 8, 9, 2, 3, 10, 11, 4, 5, 12, 13, 16, 17, 18, 19];
    let generatedSeatId = 22;
    for (let pz = 0; pz < podsZ; pz++) {
      for (let px = 0; px < podsX; px++) {
        const podIndex = pz * podsX + px, ids = Array.from({ length: 4 }, (_, index) => oldSeatIds[podIndex * 4 + index] ?? generatedSeatId++);
        this.buildPod(originX + px * podGapX, originZ + pz * podGapZ, ids, podIndex);
      }
    }
    const overflowRug = this.roundedRug(3.5, 2.6, RUGS[4]); overflowRug.position.set(-4.5, 0.006, 8); this.scene.add(overflowRug);
    this.buildDeskRow(-4.5, 8, 1, 20);
    const { width, depth } = this.options;
    const plants: [number, number, number, number, string?][] = [[-width / 2 + 1.5, 2.2, 1.0, 0], [12.35, this.watercoolerPosition.z, 0.8, 0.9, "breakroom-counter-plant"],
      [-width / 2 + 1.5, depth / 2 - 1.7, 0.9, 0], [width / 2 - 1.5, depth / 2 - 1.7, 1.05, 0]];
    for (const [x, z, s, y, id] of plants) this.plant(x, z, s, y, id);
  }

  private buildPod(cx: number, cz: number, seatIds: number[], rugId: number): void {
    const rug = this.roundedRug(3.5, 3.6, RUGS[rugId % RUGS.length]); rug.position.set(cx, 0.006, cz); this.scene.add(rug);
    this.buildDeskRow(cx, cz - 0.45, -1, seatIds[0]);
    this.buildDeskRow(cx, cz + 0.45, 1, seatIds[2]);
  }

  private buildDeskRow(cx: number, deskZ: number, rowSide: -1 | 1, baseId: number): void {
    const seatZ = deskZ + rowSide * 0.78, yaw = rowSide < 0 ? 0 : Math.PI, cupZ = deskZ - rowSide * 0.14;
    for (let side = 0; side < 2; side++) {
      const sx = cx + (side === 0 ? -0.82 : 0.82), seatId = baseId + side;
      const top = new THREE.Mesh(new RoundedBoxGeometry(1.52, 0.07, 0.78, 3, 0.035), surfaceMaterial(DESK));
      top.position.set(sx, 0.74, deskZ); top.castShadow = true; top.receiveShadow = true; this.scene.add(top);
      const topBounds = new THREE.Box3(new THREE.Vector3(sx - 0.76, 0, deskZ - 0.39), new THREE.Vector3(sx + 0.76, 0.775, deskZ + 0.39));
      this.colliders.push(topBounds); this.walkSurfaces.push({ minX: topBounds.min.x, maxX: topBounds.max.x, minZ: topBounds.min.z, maxZ: topBounds.max.z, height: 0.775 });
      for (const dx of [-0.66, 0.66]) for (const dz of [-0.3, 0.3]) { const leg = this.box(0.055, 0.71, 0.055, METAL, sx + dx, 0.355, deskZ + dz); this.colliders.push(new THREE.Box3().setFromObject(leg).expandByScalar(0.02)); }
      this.box(1.4, 0.05, 0.05, METAL, sx, 0.12, deskZ, false); this.box(1.4, 0.05, 0.05, METAL, sx, 0.68, deskZ, false);
      for (const dx of [-0.66, 0.66]) { this.box(0.05, 0.05, 0.6, METAL, sx + dx, 0.12, deskZ, false); this.box(0.05, 0.05, 0.6, METAL, sx + dx, 0.68, deskZ, false); }
      const cup = this.models.create("desk_props", "mug", { height: 0.1 }, { Mug: side ? 0xe8654f : 0x5aa8d8 });
      cup.position.set(sx + 0.55, 0.775, cupZ); this.scene.add(cup); this.registerMovable(cup, 0.075, 0.1, 0, 0);
      const seat = this.buildSeat(sx, seatZ, yaw, seatId); this.seats.push(seat); seat.chair.position.set(sx, 0, seatZ); seat.chair.rotation.y = yaw; this.scene.add(seat.chair); this.addChairColliders(sx, seatZ, yaw);
      this.desks.set(seat.id, { x: sx, z: deskZ, yaw });
    }
  }

  private buildBossDesk(): void {
    const { x, z, yaw } = this.bossSeat;
    const floorY = 3;
    const deskZ = z - 0.95;
    const rug = this.roundedRug(3.1, 2.9, 0xa9cbe8);
    rug.position.set(x, floorY + 0.007, z - 0.48);
    this.scene.add(rug);
    const top = new THREE.Mesh(new RoundedBoxGeometry(2.15, 0.09, 0.98, 3, 0.045), surfaceMaterial(DESK));
    top.position.set(x, floorY + 0.78, deskZ);
    top.receiveShadow = true;
    this.scene.add(top);
    for (const dx of [-0.92, 0.92]) {
      for (const dz of [-0.39, 0.39]) {
        const leg = this.box(0.07, 0.74, 0.07, METAL, x + dx, floorY + 0.37, deskZ + dz);
        this.colliders.push(new THREE.Box3().setFromObject(leg).expandByScalar(0.02));
      }
    }
    const deskBounds = new THREE.Box3(new THREE.Vector3(x - 1.075, floorY, deskZ - 0.49), new THREE.Vector3(x + 1.075, floorY + 0.825, deskZ + 0.49));
    this.colliders.push(deskBounds);
    const chair = this.buildSeat(x, z, yaw, 6);
    this.scene.remove(chair.marker);
    chair.chair.position.set(x, floorY, z);
    chair.chair.rotation.y = yaw;
    this.scene.add(chair.chair);
    const firstChairCollider = this.colliders.length;
    const firstChairSurface = this.walkSurfaces.length;
    this.addChairColliders(x, z, yaw);
    for (const collider of this.colliders.slice(firstChairCollider)) { collider.min.y += floorY; collider.max.y += floorY; }
    for (const surface of this.walkSurfaces.slice(firstChairSurface)) surface.height += floorY;
    this.desks.set(-1, { x, z: deskZ, yaw, laptopY: floorY + 0.84 });
    chair.id = -1;
    const laptop = this.attachLaptop(chair);
    this.bossLaptopSeat = chair;
    this.bossLaptop = laptop;
    chair.lidTarget = LID_CLOSED;
    laptop.keyboard.visible = false;
    laptop.screen.material = new THREE.MeshBasicMaterial({ color: 0x101923 });
    this.box(0.35, 0.025, 0.24, 0xe8a27f, x + 0.7, floorY + 0.84, deskZ + 0.08, false);
    const mug = this.models.create("desk_props", "mug", { height: 0.12 }, { Mug: 0x75bac3 });
    mug.position.set(x - 0.72, floorY + 0.825, deskZ + 0.12);
    this.scene.add(mug);
    this.registerMovable(mug, 0.085, 0.12, 0, 0);
  }

  private buildRooms(): void {
    const kitchenZ = this.watercoolerPosition.z;
    const loungeRug = this.roundedRug(4.45, 13.4, 0x82989a);
    loungeRug.position.set(12.55, 0.009, 0); this.scene.add(loungeRug);
    const counter = this.models.create("kitchen", "counter", { width: 2.92, height: 1.175, depth: 0.72 }, { Cabinet: 0x667c7d, Wood: 0xd9c29e });
    counter.position.set(12.05, 0, kitchenZ); this.scene.add(counter);
    this.colliders.push(new THREE.Box3(new THREE.Vector3(10.61, -0.04, kitchenZ - 0.35), new THREE.Vector3(13.49, 0.86, kitchenZ + 0.35)));
    const fridge = this.models.create("kitchen", "fridge", { width: 0.78, height: 1.72, depth: 0.72 }, { Fridge: 0xd4dedb });
    fridge.position.set(14.45, 0, kitchenZ); this.scene.add(fridge);
    this.colliders.push(new THREE.Box3(new THREE.Vector3(14.02, -0.04, kitchenZ - 0.4), new THREE.Vector3(14.88, 1.76, kitchenZ + 0.4)));
    const coffeeMachine = this.models.create("kitchen", "coffee_machine", { width: 0.48, height: 0.62, depth: 0.4 });
    coffeeMachine.position.set(11.25, 0.9, kitchenZ + 0.05);
    this.scene.add(coffeeMachine); this.coffee = new CoffeeStation(this, coffeeMachine);
    this.box(0.028, 0.24, 0.16, 0xe2d5bd, this.breakroomSwitchPosition.x, this.breakroomSwitchPosition.y, this.breakroomSwitchPosition.z, false);
    this.breakroomLever = this.box(0.045, 0.12, 0.06, 0xd8d1c2, this.breakroomSwitchPosition.x - 0.025, this.breakroomSwitchPosition.y, this.breakroomSwitchPosition.z, false);
    const cooler = new THREE.Group(), coolerX = this.watercoolerPosition.x, coolerZ = this.watercoolerPosition.z;
    const coolerBody = new THREE.Mesh(new RoundedBoxGeometry(0.58, 0.9, 0.56, 5, 0.08), surfaceMaterial(0xd4dedb, 0.34));
    coolerBody.position.set(0, 0.52, 0); coolerBody.castShadow = coolerBody.receiveShadow = true;
    for (const x of [-0.2, 0.2]) for (const z of [-0.18, 0.18]) { const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.07, 16), surfaceMaterial(0x394347, 0.86)); foot.position.set(x, 0.035, z); foot.castShadow = true; cooler.add(foot); }
    const bottleProfile = [[0.105, 1.04], [0.105, 1.12], [0.16, 1.15], [0.25, 1.21], [0.285, 1.28], [0.29, 1.33], [0.302, 1.35], [0.302, 1.38], [0.29, 1.4], [0.29, 1.64], [0.302, 1.66], [0.302, 1.7], [0.29, 1.72], [0.28, 1.8], [0.23, 1.845], [0.12, 1.865], [0, 1.87]];
    const tank = new THREE.Mesh(new THREE.LatheGeometry(bottleProfile.map(([r, y]) => new THREE.Vector2(r, y)), 48), new THREE.MeshPhysicalMaterial({ color: 0xa6d9e8, transparent: true, opacity: 0.52, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1, depthWrite: false }));
    const water = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.36, 40), new THREE.MeshPhysicalMaterial({ color: 0x5ba6c4, roughness: 0.1, transparent: true, opacity: 0.34, depthWrite: false }));
    water.position.y = 1.43;
    const bottleCap = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 32), surfaceMaterial(0x6c9da7, 0.34)); bottleCap.position.y = 1.045;
    const reservoir = this.box(0.24, 0.12, 0.24, METAL, 0, 1, 0, false);
    const recess = new THREE.Mesh(new RoundedBoxGeometry(0.38, 0.27, 0.018, 3, 0.025), surfaceMaterial(0x36494d)); recess.position.set(0, 0.865, 0.287);
    const dripTray = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.06, 0.2, 3, 0.025), surfaceMaterial(0x657274, 0.32, 0.55)); dripTray.position.set(0, 0.75, 0.35);
    for (let i = 0; i < 6; i++) { const slat = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.012, 0.16), surfaceMaterial(CHROME, 0.3, 0.7)); slat.position.set((i - 2.5) * 0.045, 0.785, 0.35); cooler.add(slat); }
    for (let i = 0; i < 4; i++) { const vent = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.012, 0.015), surfaceMaterial(0x75858a)); vent.position.set(0, 0.19 + i * 0.035, 0.283); cooler.add(vent); }
    const taps = [-0.1, 0.1].flatMap((x, index) => { const tap = this.box(0.055, 0.1, 0.045, index ? 0xb85d56 : 0x5a8fa4, x, 0.96, 0.31, false), lever = new THREE.Mesh(new RoundedBoxGeometry(0.035, 0.08, 0.035, 3, 0.01), surfaceMaterial(index ? 0xd49180 : 0x91c6d0, 0.35)); lever.position.set(x, 1.025, 0.31); return [tap, lever]; });
    this.waterCup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.12, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.86, side: THREE.DoubleSide }));
    this.waterCup.position.set(0, 0.83, 0.36); this.waterCup.visible = false;
    cooler.add(coolerBody, tank, water, bottleCap, reservoir, recess, dripTray, ...taps, this.waterCup);
    cooler.position.set(coolerX, 0, coolerZ); this.scene.add(cooler); cooler.updateMatrixWorld(true);
    this.colliders.push(new THREE.Box3().setFromObject(cooler).expandByScalar(0.04));
    const pendantTop = 3.25, cordTop = this.options.wallHeight - 0.08;
    const pendantCord = this.box(0.025, cordTop - pendantTop, 0.025, 0x454a4e, 12.65, (cordTop + pendantTop) / 2, 0, false);
    const pendant = new THREE.Mesh(new THREE.LatheGeometry([[0.31, -0.11], [0.3, -0.085], [0.265, -0.055], [0.205, -0.015], [0.14, 0.03], [0.085, 0.075], [0.045, 0.11]].map(([r, y]) => new THREE.Vector2(r, y)), 40), new THREE.MeshStandardMaterial({ color: 0xd9c39d, roughness: 0.4, metalness: 0.4, side: THREE.DoubleSide })); pendant.position.set(12.65, 3.14, 0); pendant.castShadow = true;
    this.breakroomBulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), new THREE.MeshStandardMaterial({ color: 0xf5f1e8, emissive: 0xffeac5, emissiveIntensity: 1, roughness: 0.35 })); this.breakroomBulb.position.set(12.65, 2.99, 0);
    this.breakroomLight = new THREE.SpotLight(0xffeac5, 4, 9, 1.05, 0.7, 2); this.breakroomLight.position.copy(this.breakroomBulb.position); this.breakroomLight.target.position.set(12.65, 0, 0); this.breakroomLight.castShadow = true; this.breakroomLight.shadow.mapSize.set(512, 512); this.breakroomLight.shadow.normalBias = 0.02;
    this.scene.add(pendantCord, pendant, this.breakroomBulb, this.breakroomLight, this.breakroomLight.target);
    const sofa = new THREE.Group();
    sofa.add(this.models.create("lounge", "sofa", { width: 2.65, height: 1.15, depth: 0.96 }, { Sofa: 0x527982, Frame: 0x4a4640 }));
    for (const x of [-0.78, 0.78]) { const pillow = this.models.create("lounge", "pillow", { width: 0.38, height: 0.34, depth: 0.14 }, { Cloth: 0x84a8a8 }); pillow.position.set(x, 0.57, -0.18); pillow.rotation.z = x < 0 ? 0.1 : -0.1; sofa.add(pillow); }
    sofa.position.set(10.82, 0, 0); sofa.rotation.y = Math.PI / 2; this.scene.add(sofa);
    this.colliders.push(new THREE.Box3(new THREE.Vector3(10.34, 0, -1.38), new THREE.Vector3(11.3, 1.15, 1.38)));
    for (const z of [-0.72, 0, 0.72]) { const seat = { x: 11.45, z, y: 0.18, yaw: Math.PI / 2, label: "Lounge couch" }; this.roomSeats.push(seat); this.breakroomSeats.push(seat); }
    const table = this.models.create("lounge", "coffee_table", { width: 1.05, height: 0.48, depth: 0.7 }, { Wood: 0xc6a77d, WoodDark: 0x4a4640 });
    table.position.set(12.65, 0, 0); table.rotation.y = Math.PI / 2; this.scene.add(table);
    this.colliders.push(new THREE.Box3(new THREE.Vector3(12.3, 0, -0.55), new THREE.Vector3(13, 0.5, 0.55)));
    for (const [x, z, color] of [[12.85, -3.15, 0x428e91], [12.85, 3.15, 0xd18a63]] as [number, number, number][]) {
      const pouf = this.models.create("lounge", "pouf", { width: 1.16, height: 0.66, depth: 1.1 }, { Cloth: color }); pouf.position.set(x, 0, z); this.scene.add(pouf);
      this.colliders.push(new THREE.Box3(new THREE.Vector3(x - 0.6, 0, z - 0.55), new THREE.Vector3(x + 0.6, 0.78, z + 0.55)));
      const seat = { x: x - 0.46, z, y: 0.16, yaw: Math.atan2(14.5 - x, -z), label: "Lounge pouf" }; this.roomSeats.push(seat); this.breakroomSeats.push(seat);
    }
  }
  private roundedRug(w: number, d: number, color: number): THREE.Mesh {
    const r = 0.35;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -d / 2);
    shape.lineTo(w / 2 - r, -d / 2);
    shape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
    shape.lineTo(w / 2, d / 2 - r);
    shape.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
    shape.lineTo(-w / 2 + r, d / 2);
    shape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
    shape.lineTo(-w / 2, -d / 2 + r);
    shape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
    const rug = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color }));
    rug.rotation.x = -Math.PI / 2;
    rug.receiveShadow = true;
    return rug;
  }

  private buildSeat(sx: number, seatZ: number, yaw: number, id: number): Seat {
    const color = CHAIRS[id % CHAIRS.length];
    const fabric = surfaceMaterial(color, 0.96), shell = surfaceMaterial(0x39444b, 0.55), chrome = surfaceMaterial(CHROME, 0.3, 0.7), rubber = surfaceMaterial(0x252c30, 0.9), stitch = surfaceMaterial(new THREE.Color(color).multiplyScalar(0.72).getHex(), 0.96);
    const chair = new THREE.Group();

    const seatShell = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.062, 0.38, 4, 0.03), shell); seatShell.position.y = 0.427;
    const cushion = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.09, 0.364, 5, 0.044), fabric); cushion.position.y = 0.475;
    const backShell = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.39, 0.065, 5, 0.032), shell); backShell.position.set(0, 0.73, -0.225);
    const backRest = new THREE.Mesh(new RoundedBoxGeometry(0.398, 0.35, 0.06, 5, 0.03), fabric); backRest.position.set(0, 0.728, -0.186);
    const lumbar = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.075, 0.028, 4, 0.014), fabric); lumbar.position.set(0, 0.635, -0.153);
    const support = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.25, 0.035), chrome);
    support.position.set(0, 0.57, -0.2);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.33, 24), surfaceMaterial(METAL, 0.4, 0.55));
    stem.position.y = 0.23;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.05, 24), chrome);
    hub.position.y = 0.08;
    chair.add(seatShell, cushion, backShell, backRest, lumbar, support, stem, hub);
    for (const side of [-1, 1]) {
      const armSupport = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(side * 0.175, 0.45, -0.095), new THREE.Vector3(side * 0.185, 0.56, -0.095), new THREE.Vector3(side * 0.19, 0.63, -0.06)]), 12, 0.009, 8, false), shell);
      const armPad = new THREE.Mesh(new RoundedBoxGeometry(0.047, 0.034, 0.23, 4, 0.016), shell); armPad.position.set(side * 0.19, 0.645, -0.005);
      const seam = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(side * 0.145, 0.585, -0.153), new THREE.Vector3(side * 0.165, 0.725, -0.153), new THREE.Vector3(side * 0.145, 0.865, -0.153)]), 12, 0.002, 5, false), stitch);
      chair.add(armSupport, armPad, seam);
    }
    for (let i = 0; i < 5; i++) {
      const angle = i / 5 * Math.PI * 2;
      const arm = new THREE.Mesh(new RoundedBoxGeometry(0.23, 0.032, 0.04, 3, 0.016), chrome); arm.position.set(Math.cos(angle) * 0.115, 0.07, Math.sin(angle) * 0.115); arm.rotation.y = -angle;
      const caster = new THREE.Group(); caster.position.set(Math.cos(angle) * 0.205, 0, Math.sin(angle) * 0.205); caster.rotation.y = -angle;
      const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.05, 12), shell); fork.position.y = 0.06;
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.026, 20), rubber); wheel.rotation.x = Math.PI / 2; wheel.position.y = 0.035;
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.03, 16), chrome); axle.rotation.x = Math.PI / 2; axle.position.y = 0.035;
      caster.add(fork, wheel, axle); chair.add(arm, caster);
    }
    chair.traverse((part) => { if (part instanceof THREE.Mesh) { part.castShadow = true; part.receiveShadow = true; } });
    mergeStaticMeshes(chair);
    const marker = new THREE.Group();
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x3ddc84 });
    marker.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), markerMaterial));
    marker.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.06), markerMaterial));
    marker.position.set(sx, 1.28, seatZ);
    this.scene.add(marker);
    return { id, x: sx, z: seatZ, yaw, occupant: null, chair, marker, laptop: null, lid: LID_CLOSED, lidTarget: LID_CLOSED };
  }

  attachLaptop(seat: Seat): Laptop {
    if (seat.laptop) return seat.laptop;
    const point = this.desks.get(seat.id)!;
    const lidDepth = 0.014;
    const base = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.02, 0.31, 2, 0.008), surfaceMaterial(METAL, 0.4, 0.55));
    base.position.set(point.x, point.laptopY ?? 0.785, point.z - (seat.id >= 0 ? Math.cos(seat.yaw) * 0.2 : 0));
    base.rotation.y = Math.PI - point.yaw;
    base.castShadow = true;
    this.scene.add(base);
    const keyboardGroup = new THREE.Group();
    const keyboard = new THREE.Mesh(new RoundedBoxGeometry(0.4, 0.006, 0.17, 2, 0.004), surfaceMaterial(0x4b4d55));
    keyboard.position.set(0, 0.014, -0.025);
    keyboardGroup.add(keyboard);
    const keys = new THREE.InstancedMesh(new THREE.BoxGeometry(0.025, 0.003, 0.019), surfaceMaterial(0xc7c9cc), 40);
    const matrix = new THREE.Matrix4();
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 10; col++) {
        matrix.makeTranslation((col - 4.5) * 0.035, 0.019, -0.085 + row * 0.036);
        keys.setMatrixAt(row * 10 + col, matrix);
      }
    }
    keyboardGroup.add(keys);
    const trackpad = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.002, 0.05, 2, 0.001), surfaceMaterial(0xb1b3b6));
    trackpad.position.set(0, 0.013, 0.105);
    keyboardGroup.add(trackpad);
    keyboardGroup.visible = seat.lid < 0.55;
    base.add(keyboardGroup);

    const hinge = new THREE.Group();
    hinge.position.set(0, 0.01, -0.145);
    base.add(hinge);
    const lid = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.29, lidDepth, 2, 0.006), surfaceMaterial(METAL, 0.4, 0.55));
    lid.position.y = 0.145;
    lid.castShadow = true;
    hinge.add(lid);
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xea7c5e, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    badge.rotation.y = Math.PI;
    badge.position.set(0, 0.15, -lidDepth / 2 - 0.002);
    hinge.add(badge);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.41, 0.245), new THREE.MeshBasicMaterial({ color: 0x161c22 }));
    screen.position.set(0, 0.145, lidDepth / 2 + 0.001);
    hinge.add(screen);
    hinge.rotation.x = LID_CLOSED;
    seat.laptop = { pivot: hinge, screen, base, badge, keyboard: keyboardGroup };
    return seat.laptop;
  }

  setLaptopIcon(laptop: Laptop, path: string, accent: string): void {
    const material = laptop.badge.material as THREE.MeshBasicMaterial;
    material.color.set(accent);
    material.map = null;
    if (path) {
      let texture = this.laptopIconTextures.get(path);
      if (!texture) {
        texture = new THREE.TextureLoader().load(path);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        this.laptopIconTextures.set(path, texture);
      }
      material.color.set(0xffffff);
      material.map = texture;
    }
    material.needsUpdate = true;
  }

  restoreLaptopAfterFailedDeparture(seat: Seat): void { if (seat.laptop) { seat.laptop.base.visible = true; seat.laptop.base.scale.setScalar(1); seat.lidTarget = LID_OPEN; } }

  detachLaptop(seat: Seat): void {
    if (!seat.laptop) return;
    this.scene.remove(seat.laptop.base);
    seat.laptop = null;
    seat.lid = LID_CLOSED;
    seat.lidTarget = LID_CLOSED;
  }

  freeSeat(): Seat | undefined {
    return this.seats.find((seat) => seat.occupant === null);
  }

  roomSeatAt(x: number, z: number): { x: number; z: number; y: number; yaw: number; label: string } | undefined {
    let nearest: { x: number; z: number; y: number; yaw: number; label: string } | undefined, distance = 1.1;
    for (const seat of this.roomSeats) {
      const next = Math.hypot(seat.x - x, seat.z - z);
      if (next < distance) { nearest = seat; distance = next; }
    }
    return nearest;
  }

  release(occupant: string): void {
    for (const seat of this.seats) {
      if (seat.occupant === occupant) {
        seat.occupant = null;
        this.detachLaptop(seat);
      }
    }
  }

  update(dt: number, playerX?: number, playerZ?: number): void {
    this.coffee.update(dt);
    const time = performance.now() * 0.002;
    this.weather.update(dt);
    updateOutdoor(this.scene, dt, this.weather.season, this.weather.current, this.weather.windStrength, this.weather.lighting.calendar);
    if (this.shadowSunDirection.distanceToSquared(this.weather.lighting.sunDirection) > 0.00001) { this.shadowDirty = true; this.shadowSunDirection.copy(this.weather.lighting.sunDirection); }
    this.updateWallClock();
    if (this.outdoorNight !== this.weather.isNight) {
      this.outdoorNight = this.weather.isNight;
      setOutdoorNight(this.scene, this.outdoorNight);
    }
    this.elevator.update(dt);
    this.updateBlinds(dt);
    this.updateExitDoor(dt);
    this.updateTraffic(dt);
    for (const door of this.autoDoors) {
      const distance = playerX === undefined || playerZ === undefined ? Infinity : Math.hypot(playerX - door.x, playerZ - door.centerZ);
      const target = distance < 1.5 ? 1 : distance > 2.4 ? 0 : door.target;
      if (target !== door.target) this.doorSoundPending = true;
      if (Math.abs(target - door.open) > 0.001) this.invalidateShadows();
      door.target = target;
      door.open += (door.target - door.open) * Math.min(1, dt * 5);
      const sideDistance = (door.bounds.max.z - door.bounds.min.z) * 0.25 + door.open * ((door.bounds.max.z - door.bounds.min.z) * 0.5 + 0.12);
      for (const panel of door.panels) panel.position.z = door.centerZ + (panel.userData.side as number) * sideDistance;
      if (door.open > 0.96) { door.bounds.min.y = 2.2; door.bounds.max.y = 2.1; }
      else { door.bounds.min.y = 0; door.bounds.max.y = 2.16; }
    }
    if (this.exitDoorOpen) {
      this.exitDoorCloseTimer = Math.max(0, this.exitDoorCloseTimer - dt);
      if (this.exitDoorCloseTimer === 0 && playerX !== undefined && playerZ !== undefined && !this.isNearExitDoor(playerX, playerZ)) this.setExitDoorOpen(false);
    }
    for (const seat of this.seats) {
      seat.marker.visible = this.showDeskMarkers && seat.occupant === null;
      seat.marker.position.y = 1.28 + Math.sin(time + seat.id) * 0.07;
      this.updateLaptopLid(seat, dt);
    }
    if (this.bossLaptopSeat) this.updateLaptopLid(this.bossLaptopSeat, dt);
  }

  resize(): void {
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  invalidateShadows(): void { this.shadowDirty = true; }
  setShadowMotion(active: boolean): void { this.shadowMotion = active; }
  render(): void {
    const now = performance.now();
    if ((this.shadowDirty || this.shadowMotion) && now - this.lastShadowUpdate >= 100) { this.renderer.shadowMap.needsUpdate = true; this.lastShadowUpdate = now; this.shadowDirty = false; }
    this.renderer.render(this.scene, this.camera);
  }
}
