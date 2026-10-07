import * as THREE from "three";
import type { Api, AgentProfile, Terminal } from "./api";
import type { Office, Seat } from "./office";
import { LID_CLOSED, LID_OPEN } from "./office";
import { buildAgent, setSitting, setWalking, type Figure } from "./player";
import { defaultModelIcon, modelIconPath } from "./model_icons";
import { TerminalScreen, type DesktopPreview } from "./terminal_screen";

export type WorkerState = "idle" | "working" | "needs_input" | "done" | "failed" | "parked";
export type WorkerAttentionTarget = { x: number; y: number; z: number };

const STATE_LABEL: Record<WorkerState, string> = {
  idle: "ready",
  working: "working",
  needs_input: "Needs help · T terminal",
  done: "✓ done!",
  failed: "failed",
  parked: "parked"
};
const STATE_COLOR: Record<WorkerState, string> = {
  idle: "#7c8aa0",
  working: "#2f9e5f",
  needs_input: "#c28b2c",
  done: "#2f9e5f",
  failed: "#c0392b",
  parked: "#8a8a8a"
};

type Activity = "cooler" | "breakroom" | "help";
type BreakPhase = "seated" | "outbound" | "using" | "returning";
type Point = { x: number; z: number };

export class Worker {
  readonly figure: Figure;
  readonly plate: HTMLElement;
  readonly badge: HTMLElement;
  name: string;
  icon: string;
  state: WorkerState = "idle";
  time = Math.random() * 10;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private texture = new THREE.CanvasTexture(this.canvas);
  private terminalScreen: TerminalScreen;
  private desktopKey = "";
  private desktopPreviewSignature = "";
  private hasDesktopSnapshot = false;
  private dirty = true;
  private lastDraw = 0;
  private breakPhase: BreakPhase = "seated";
  private route: Point[] = [];
  private outbound: Point[] = [];
  private routeIndex = 0;
  private activity: Activity = "cooler";
  private breakSeatY = 0.28;
  private breakSeatYaw = Math.PI / 2;
  private visitTime = 0;
  private departure: { route: Point[]; index: number; elapsed: number; state: WorkerState; finish: () => Promise<boolean>; keepComputer: boolean; atDesk: boolean } | null = null;
  private dayState: WorkerState | null = null;
  private arrivalState: WorkerState | null = null;
  private seatedPosition = new THREE.Vector3();
  private attentionGoal?: WorkerAttentionTarget;
  private attentionRepathAt = 0;
  private celebrationAt = -2;
  private routeRepathAt = 0;
  private typingTarget = new THREE.Vector3();
  private typingDirection = new THREE.Vector3();
  private typingAxis = new THREE.Vector3();
  private typingKey = new THREE.Matrix4();
  private typingReach = 0;
  private armJointOffsets = new Map<THREE.Object3D, number>();

  constructor(readonly terminalId: string, name: string, readonly role: string, readonly accent: string, readonly seat: Seat, layer: HTMLElement, private office: Office, cols = 100, rows = 28, icon = "", private attentionTarget: () => WorkerAttentionTarget | undefined = () => undefined) {
    this.name = name;
    this.icon = icon;
    this.terminalScreen = new TerminalScreen(cols, rows);
    this.figure = buildAgent(parseInt(accent.replace("#", ""), 16));
    for (const arm of [this.figure.armL, this.figure.armR]) { const hand = arm.children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry); for (const child of arm.children) if (child !== hand && child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry) this.armJointOffsets.set(child, child.position.y); }
    this.sitAtDesk();
    seat.occupant = terminalId;
    const laptop = this.office.attachLaptop(seat);
    this.office.setLaptopIcon(laptop, modelIconPath(icon), accent);
    seat.lidTarget = LID_OPEN;

    this.canvas.width = 768;
    this.canvas.height = 459;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    laptop.screen.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });

    this.plate = document.createElement("div");
    this.plate.className = "nameplate";
    layer.appendChild(this.plate);
    this.badge = document.createElement("div");
    this.badge.className = "statebadge";
    layer.appendChild(this.badge);
    this.render();
  }

  write(data: string): void {
    if (this.desktopKey) return;
    this.terminalScreen.write(data, () => { this.dirty = true; });
  }

  setDesktopPreview(preview: DesktopPreview): void {
    const signature = `${preview.key}|${preview.title}|${preview.terminal}|${preview.snapshotId ?? 0}`;
    if (signature === this.desktopPreviewSignature) return;
    this.desktopPreviewSignature = signature;
    this.hasDesktopSnapshot = !!preview.snapshot;
    this.desktopKey = preview.key;
    this.terminalScreen.setDesktopPreview(preview);
    this.dirty = true;
    this.redraw();
  }

  writeDesktop(key: string, data: string): void {
    if (this.desktopKey !== key || this.hasDesktopSnapshot) return;
    this.terminalScreen.write(data, () => { this.dirty = true; });
  }

  resizeTerminal(cols: number, rows: number): void {
    this.terminalScreen.resize(cols, rows);
    this.dirty = true;
  }

  private redraw(): void {
    this.terminalScreen.paint(this.ctx, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
  }

  setState(state: WorkerState): void {
    if (state === "done" && (this.state === "working" || this.state === "needs_input")) this.celebrationAt = this.time;
    this.state = state;
    if (state !== "needs_input" && this.activity === "help") { this.attentionGoal = undefined; if (this.breakPhase === "outbound" || this.breakPhase === "using") this.returnToSeat(); }
    if ((state === "failed" || state === "parked") && (this.breakPhase === "outbound" || this.breakPhase === "using")) this.returnToSeat();
    if (this.breakPhase === "seated" && !this.departure) this.sitAtDesk();
    this.dirty = true;
    this.render();
  }

  updateMetadata(title: string, icon: string): void {
    this.name = title;
    this.icon = icon;
    this.plate.textContent = title;
    if (this.seat.laptop) this.office.setLaptopIcon(this.seat.laptop, modelIconPath(icon), this.accent);
  }

  get onBreak(): boolean { return this.breakPhase !== "seated" || this.departure !== null; }
  get isLeaving(): boolean { return this.departure !== null; }
  get isHomeForDay(): boolean { return this.dayState !== null || this.departure?.keepComputer === true; }
  get isReturningToOffice(): boolean { return this.arrivalState !== null; }

  depart(route: Point[], finish: () => Promise<boolean>, keepComputer = false): void {
    if (this.departure) return;
    const state = this.arrivalState ?? this.state;
    this.arrivalState = null;
    const pack = this.breakPhase === "seated";
    this.breakPhase = "seated";
    this.figure.root.visible = true;
    this.seat.lidTarget = LID_CLOSED;
    this.departure = { route, index: 0, elapsed: pack ? 0 : 0.8, state, finish, keepComputer, atDesk: pack };
    this.setState("parked");
  }

  startBreak(activity: "cooler" | "breakroom"): void {
    if (this.onBreak || this.state === "failed" || this.state === "parked") return;
    this.activity = activity;
    const destination = activity === "cooler" ? { x: this.office.watercoolerPosition.x, z: this.office.watercoolerPosition.z + 1.05, y: 0, yaw: Math.PI } : this.office.breakroomSeats[Math.floor(Math.random() * this.office.breakroomSeats.length)] ?? { x: 12.4, z: -3.15, y: 0.16, yaw: Math.PI / 2 };
    this.breakSeatY = destination.y + 0.28;
    this.breakSeatYaw = destination.yaw;
    this.outbound = this.office.findAgentRoute(this.figure.root.position.x, this.figure.root.position.z, destination.x, destination.z);
    this.route = this.outbound;
    this.routeIndex = 0;
    this.breakPhase = "outbound";
  }

  private returnToSeat(): void {
    if (this.breakPhase === "returning" || this.breakPhase === "seated") return;
    const seatPoint = this.deskApproach();
    this.route = seatPoint ? this.routeToPoint(seatPoint, this.seat.chair.position.y) : [];
    this.routeIndex = 0;
    this.breakPhase = "returning";
    this.figure.root.visible = true;
  }

  private sitAtDesk(): void {
    this.seat.chair.updateWorldMatrix(true, false);
    this.figure.root.position.copy(this.seat.chair.localToWorld(this.seatedPosition.set(0, 0.28, 0.06)));
    this.figure.root.rotation.set(0, this.seat.yaw, 0);
    setSitting(this.figure, 1, this.time);
  }

  private deskApproach(): Point | undefined {
    const root = this.figure.root, sin = Math.sin(this.seat.yaw), cos = Math.cos(this.seat.yaw), y = this.seat.chair.position.y;
    const points = [-0.65, 0.65].map((x) => ({ x: this.seat.x + cos * x + sin * 0.06, z: this.seat.z - sin * x + cos * 0.06 })).sort((a, b) => Math.hypot(a.x - root.position.x, a.z - root.position.z) - Math.hypot(b.x - root.position.x, b.z - root.position.z));
    return points.find((point) => !this.office.colliders.some((box) => box.max.y > y + 0.08 && box.min.y < y + 1.55 && point.x + 0.31 > box.min.x && point.x - 0.31 < box.max.x && point.z + 0.31 > box.min.z && point.z - 0.31 < box.max.z));
  }

  private routeToPoint(target: Point, floor: number): Point[] {
    const position = this.figure.root.position, start = { x: 2.4, z: 9.45 }, landing = { x: 8.7, z: 9.45 }, stairs = [start, ...Array.from({ length: 21 }, (_, index) => ({ x: 2.4 + (index + 0.5) * 0.27, z: 9.45 })), landing];
    const currentFloor = position.y > 1.5 ? 3 : 0, onStairs = position.x >= start.x - 0.05 && position.x < landing.x - 0.05 && Math.abs(position.z - start.z) < 0.35;
    if (!onStairs && currentFloor === floor) return this.office.findAgentRoute(position.x, position.z, target.x, target.z, floor);
    const up = floor > 1.5, exit = up ? landing : start, upper = this.office.findAgentRoute(exit.x, exit.z, target.x, target.z, floor);
    if (!upper.length && Math.hypot(exit.x - target.x, exit.z - target.z) > 0.1) return [];
    if (onStairs) return [...(up ? stairs.filter((point) => point.x > position.x + 0.01) : [...stairs].reverse().filter((point) => point.x < position.x - 0.01)), ...upper];
    const entry = up ? start : landing, lower = this.office.findAgentRoute(position.x, position.z, entry.x, entry.z, currentFloor);
    if (!lower.length && Math.hypot(position.x - entry.x, position.z - entry.z) > 0.1) return [];
    return [...lower, ...(up ? stairs.slice(1) : [...stairs].reverse().slice(1)), ...upper];
  }

  private typeAtKeyboard(): void {
    const keys = this.seat.laptop?.keyboard.children.find((object): object is THREE.InstancedMesh => object instanceof THREE.InstancedMesh);
    if (!keys) return;
    for (const [arm, side] of [[this.figure.armL, -1], [this.figure.armR, 1]] as const) {
      const hand = arm.children.find((object): object is THREE.Mesh<THREE.SphereGeometry> => object instanceof THREE.Mesh && object.geometry instanceof THREE.SphereGeometry);
      if (!hand) continue;
      const tap = Math.max(0, Math.sin(this.time * 22 + (side < 0 ? 0 : 1.7))), index = (1 + Math.floor(this.time * 3) % 2) * 10 + (side < 0 ? 7 : 2);
      keys.getMatrixAt(index, this.typingKey); this.typingTarget.setFromMatrixPosition(this.typingKey); this.typingTarget.y += hand.geometry.parameters.radius + 0.002 + tap * 0.008;
      keys.localToWorld(this.typingTarget); this.figure.body.worldToLocal(this.typingTarget); this.typingDirection.copy(this.typingTarget).sub(arm.position);
      const extension = THREE.MathUtils.lerp(1, Math.min(1.35, Math.max(1, Math.sqrt(Math.max(0, this.typingDirection.lengthSq() - hand.position.x ** 2 - hand.position.z ** 2)) / Math.abs(hand.position.y))), this.typingReach);
      arm.scale.y = extension; this.typingAxis.copy(hand.position); this.typingAxis.y *= extension; arm.quaternion.setFromUnitVectors(this.typingAxis.normalize(), this.typingDirection.normalize());
      for (const child of arm.children) if (child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry) { child.scale.y = 1 / extension; const offset = this.armJointOffsets.get(child); if (offset !== undefined) child.position.y = offset / extension; }
    }
    keys.getMatrixAt(15, this.typingKey); this.typingTarget.setFromMatrixPosition(this.typingKey); keys.localToWorld(this.typingTarget); this.figure.body.worldToLocal(this.typingTarget); this.typingDirection.copy(this.typingTarget).sub(this.figure.head.position);
    this.figure.head.rotation.x = THREE.MathUtils.clamp(Math.atan2(-this.typingDirection.y, Math.hypot(this.typingDirection.x, this.typingDirection.z)), 0.08, 0.5) + Math.sin(this.time * 2.2) * 0.02;
    this.figure.head.rotation.y = THREE.MathUtils.clamp(Math.atan2(this.typingDirection.x, this.typingDirection.z), -0.15, 0.15);
  }

  private updateAttention(): void {
    if (this.state !== "needs_input" || this.departure || this.dayState !== null || this.arrivalState !== null || this.breakPhase === "returning" || this.time < this.attentionRepathAt) return;
    this.attentionRepathAt = this.time + 1;
    const target = this.attentionTarget(), root = this.figure.root;
    if (!target) return;
    const floor = Math.abs(target.y - 3) < 0.5 ? 3 : Math.abs(target.y) < 0.5 ? 0 : undefined;
    if (floor === undefined || this.breakPhase === "outbound" && root.position.x >= 2.35 && root.position.x < 8.65 && Math.abs(root.position.z - 9.45) < 0.35) return;
    if (this.attentionGoal && Math.abs(target.y - this.attentionGoal.y) < 0.3 && Math.hypot(target.x - this.attentionGoal.x, target.z - this.attentionGoal.z) < 0.75) return;
    if (this.breakPhase === "seated" && Math.abs(target.y - root.position.y) < 0.8 && Math.hypot(target.x - root.position.x, target.z - root.position.z) < 1.6) return;
    const angle = Math.atan2(root.position.x - target.x, root.position.z - target.z), radius = 0.31;
    for (const heading of [angle, -Math.PI / 2, Math.PI / 2, Math.PI, 0]) {
      const x = target.x + Math.sin(heading) * 1.4, z = target.z + Math.cos(heading) * 1.4;
      if (Math.abs(this.office.walkSurfaceAt(x, z, floor) - floor) > 0.3 || this.office.colliders.some((box) => box.max.y > floor + 0.08 && box.min.y < floor + 1.55 && x + radius > box.min.x && x - radius < box.max.x && z + radius > box.min.z && z - radius < box.max.z)) continue;
      const route = this.routeToPoint({ x, z }, floor);
      if (!route.length) continue;
      this.activity = "help";
      this.attentionGoal = { ...target };
      this.breakSeatYaw = Math.atan2(target.x - x, target.z - z);
      this.route = route;
      this.routeIndex = 0;
      this.breakPhase = "outbound";
      return;
    }
  }

  private walk(dt: number): void {
    const target = this.route[this.routeIndex];
    if (!target) { if (this.breakPhase === "returning" && this.time >= this.routeRepathAt) { this.routeRepathAt = this.time + 1; const point = this.deskApproach(); if (point) { this.route = this.routeToPoint(point, this.seat.chair.position.y); this.routeIndex = 0; } } return; }
    const root = this.figure.root;
    const dx = target.x - root.position.x;
    const dz = target.z - root.position.z;
    const distance = Math.hypot(dx, dz);
    const step = Math.min(distance, dt * 2.1);
    const nextX = distance <= step ? target.x : root.position.x + dx / distance * step, nextZ = distance <= step ? target.z : root.position.z + dz / distance * step;
    if (distance > 0.001) root.rotation.y = Math.atan2(dx, dz);
    const nextY = this.office.walkSurfaceAt(nextX, nextZ, root.position.y);
    if (nextY - root.position.y > 0.27 || !this.office.canAgentMove(root.position.x, root.position.z, nextX, nextZ, Math.max(root.position.y, nextY), target.x, target.z)) {
      if (this.time >= this.routeRepathAt) { this.routeRepathAt = this.time + 1; const detour = this.office.findAgentRoute(root.position.x, root.position.z, target.x, target.z, root.position.y > 2.8 ? 3 : root.position.y < 0.8 ? 0 : root.position.y); if (detour.length) this.route.splice(this.routeIndex, 1, ...detour); }
      if (Math.hypot(root.position.x - this.seat.x, root.position.z - this.seat.z) < 0.14) this.sitAtDesk(); else setWalking(this.figure, this.time, false, this.time);
      return;
    }
    root.position.x = nextX;
    root.position.z = nextZ;
    root.position.y = nextY;
    this.figure.head.rotation.x = 0;
    setWalking(this.figure, this.time, true, this.time);
    if (distance > step + 0.001) return;
    if (++this.routeIndex < this.route.length) return;
    if (this.breakPhase === "outbound") {
      this.breakPhase = "using";
      this.visitTime = this.activity === "help" ? Infinity : this.activity === "breakroom" ? 8 + Math.random() * 7 : 3.5 + Math.random() * 2;
      if (this.activity === "cooler") this.office.useWatercooler();
      if (this.activity === "breakroom") root.position.y = this.breakSeatY;
      root.rotation.y = this.breakSeatYaw;
    } else {
      this.breakPhase = "seated";
      this.sitAtDesk();
      this.figure.head.rotation.x = 0;
      setSitting(this.figure, 1, this.time);
      if (this.arrivalState !== null) {
        this.seat.lidTarget = LID_OPEN;
        const state = this.arrivalState;
        this.arrivalState = null;
        this.setState(state);
      }
    }
  }

  private walkOut(dt: number): void {
    const leaving = this.departure;
    if (!leaving) return;
    const root = this.figure.root;
    leaving.elapsed += dt;
    if (leaving.elapsed < 0.8) {
      if (leaving.atDesk) this.sitAtDesk();
      return;
    }
    let move = dt * 2.3, blocked = false;
    while (move > 0 && leaving.index < leaving.route.length) {
      const target = leaving.route[leaving.index];
      const dx = target.x - root.position.x;
      const dz = target.z - root.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 1e-4) root.rotation.y = Math.atan2(dx, dz);
      const step = Math.min(distance, move), nextX = distance <= move ? target.x : root.position.x + dx / distance * step, nextZ = distance <= move ? target.z : root.position.z + dz / distance * step;
      if (!this.office.canAgentMove(root.position.x, root.position.z, nextX, nextZ, root.position.y, target.x, target.z)) {
        if (this.time >= this.routeRepathAt) { this.routeRepathAt = this.time + 1; const detour = this.office.findAgentRoute(root.position.x, root.position.z, target.x, target.z); if (detour.length) leaving.route.splice(leaving.index, 1, ...detour); }
        blocked = true; move = 0; break;
      }
      if (distance <= move) {
        root.position.x = nextX;
        root.position.z = nextZ;
        move -= distance;
        leaving.index++;
      } else {
        root.position.x = nextX;
        root.position.z = nextZ;
        move = 0;
      }
      root.position.y = this.office.walkSurfaceAt(root.position.x, root.position.z, root.position.y);
    }
    setWalking(this.figure, this.time, leaving.index < leaving.route.length && !blocked, this.time);
    if (leaving.index < leaving.route.length) return;
    this.departure = null;
    void leaving.finish().then((removed) => {
      if (removed) {
        root.visible = false;
        if (leaving.keepComputer) this.dayState = leaving.state;
        return;
      }
      this.office.restoreLaptopAfterFailedDeparture(this.seat);
      this.sitAtDesk();
      this.setState(leaving.state);
    });
  }

  returnToOffice(): void {
    if (this.arrivalState !== null && !this.departure) return;
    const seatPoint = this.deskApproach();
    if (!seatPoint) return;
    let state: WorkerState | null = null;
    if (this.departure?.keepComputer) {
      state = this.departure.state;
      this.route = [...this.departure.route.slice(0, this.departure.index).reverse(), seatPoint];
      this.departure = null;
    } else if (this.dayState !== null) {
      state = this.dayState;
      this.dayState = null;
      const returnRoute = this.office.findOfficeReturnRoute(seatPoint.x, seatPoint.z);
      this.figure.root.position.set(returnRoute.spawn.x, this.office.walkSurfaceAt(returnRoute.spawn.x, returnRoute.spawn.z, -3.6), returnRoute.spawn.z);
      this.route = returnRoute.route;
    }
    if (state === null) return;
    this.figure.root.visible = true;
    this.routeIndex = 0;
    this.breakPhase = "returning";
    this.arrivalState = state;
    this.setState("idle");
  }

  private render(): void {
    this.plate.textContent = this.name;
    this.badge.textContent = STATE_LABEL[this.state];
    this.badge.style.background = STATE_COLOR[this.state];
    this.badge.style.display = this.state === "idle" ? "none" : "block";
  }

  update(dt: number): void {
    this.time += dt;
    if (this.breakPhase !== "seated" || this.departure || this.state !== "working") this.typingReach = 0;
    this.figure.body.rotation.x = this.figure.body.rotation.y = 0;
    this.figure.head.rotation.x = 0;
    this.figure.armL.rotation.z = -0.08; this.figure.armR.rotation.z = 0.08;
    for (const arm of [this.figure.armL, this.figure.armR]) { arm.scale.set(1, 1, 1); arm.rotation.y = 0; for (const child of arm.children) if (child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry) { child.scale.y = 1; const offset = this.armJointOffsets.get(child); if (offset !== undefined) child.position.y = offset; } }
    this.updateAttention();
    if (this.dirty && this.time - this.lastDraw > 1 / 30) {
      this.redraw();
      this.dirty = false;
      this.lastDraw = this.time;
    }
    if (this.departure) this.walkOut(dt);
    else if (this.breakPhase === "outbound" || this.breakPhase === "returning") this.walk(dt);
    else if (this.breakPhase === "using") {
      if (this.activity === "breakroom") setSitting(this.figure, 1, this.time);
      else if (this.activity === "cooler") {
        setWalking(this.figure, this.time, false, this.time);
        this.figure.head.rotation.x = 0.12 + Math.sin(this.time * 5) * 0.08;
      } else if (this.activity === "help") {
        setWalking(this.figure, this.time, false, this.time);
        const target = this.attentionTarget(), root = this.figure.root;
        if (target) root.rotation.y = Math.atan2(target.x - root.position.x, target.z - root.position.z);
        this.figure.armR.rotation.x = -2.35; this.figure.armR.rotation.z = 0.25 + Math.sin(this.time * 7) * 0.18;
        this.figure.head.rotation.x = -0.06; this.figure.head.rotation.y = Math.sin(this.time * 1.8) * 0.09;
      }
      this.visitTime -= dt;
      if (this.visitTime <= 0) this.returnToSeat();
    } else {
      this.sitAtDesk();
      if (this.state === "working") {
        this.typingReach = Math.min(1, this.typingReach + dt * 6);
        this.figure.body.position.y = -0.14 + Math.abs(Math.sin(this.time * 11)) * 0.02;
        this.figure.body.rotation.x = 0.125;
        this.typeAtKeyboard();
      } else {
        this.figure.armL.rotation.x = THREE.MathUtils.lerp(this.figure.armL.rotation.x, -0.3, 0.2);
        this.figure.armR.rotation.x = THREE.MathUtils.lerp(this.figure.armR.rotation.x, -0.3, 0.2);
        this.figure.body.position.y = -0.14 + Math.sin(this.time * 2) * 0.015;
        this.figure.head.rotation.x = Math.sin(this.time * 1.6) * 0.025;
        if (this.state === "needs_input") { this.figure.armR.rotation.x = -2.35; this.figure.armR.rotation.z = 0.22 + Math.sin(this.time * 7) * 0.16; }
        if (this.state === "failed") this.figure.head.rotation.x = 0.16;
        if (this.state === "done" && this.time - this.celebrationAt < 0.9) { const progress = (this.time - this.celebrationAt) / 0.9; this.figure.armL.rotation.x = this.figure.armR.rotation.x = -2.6; this.figure.body.rotation.y = Math.sin(progress * Math.PI * 2) * 0.22; this.figure.body.position.y += Math.sin(progress * Math.PI) * 0.06; }
      }
    }
  }

  place(camera: THREE.Camera, width: number, height: number): void {
    const project = (y: number) => {
      const position = this.figure.root.position;
      const point = new THREE.Vector3(position.x, position.y + y, position.z).project(camera);
      return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height, z: point.z };
    };
    const head = project(1.3);
    const onScreen = this.figure.root.visible && head.z >= -1 && head.z <= 1 && head.x > 8 && head.x < width - 8 && head.y > 8 && head.y < height - 8;
    this.plate.style.left = `${head.x}px`;
    this.plate.style.top = `${head.y}px`;
    this.plate.style.display = onScreen ? "block" : "none";
    const badge = project(1.66);
    this.badge.style.left = `${badge.x}px`;
    this.badge.style.top = `${badge.y}px`;
    this.badge.style.display = onScreen && this.state !== "idle" ? "block" : "none";
  }

  dispose(): void {
    this.office.scene.remove(this.figure.root);
    this.terminalScreen.dispose();
    this.texture.dispose();
    this.plate.remove();
    this.badge.remove();
  }
}

export class Workers {
  private workers = new Map<string, Worker>();
  private officeClosed = false;
  private returnDoorOpen = false;
  private breakCooldown = 45 + Math.random() * 45;
  private lastActivity: Activity | null = null;
  private attentionTarget: () => WorkerAttentionTarget | undefined = () => undefined;

  constructor(private api: Api, private office: Office, private layer: HTMLElement) {}
  setAttentionTarget(target: () => WorkerAttentionTarget | undefined): void { this.attentionTarget = target; }

  get all(): Worker[] {
    return [...this.workers.values()];
  }

  at(seatId: number): Worker | undefined {
    return this.all.find((worker) => worker.seat.id === seatId);
  }

  adopt(terminal: Terminal, seat?: Seat): Worker | undefined {
    if (terminal.profileId === "boss-shell") return undefined;
    if (this.workers.has(terminal.id)) return this.workers.get(terminal.id);
    const savedSeat = this.office.seats.find((item) => Math.hypot(item.x - Number(terminal.swarmX), item.z - Number(terminal.swarmY)) < 0.05);
    const chosen = seat ?? savedSeat ?? this.office.freeSeat();
    if (!chosen || chosen.occupant !== null) return undefined;
    const worker = new Worker(terminal.id, terminal.title, terminal.role, terminal.accent || "#5b8cff", chosen, this.layer, this.office, terminal.cols || 100, terminal.rows || 28, terminal.icon || defaultModelIcon(terminal.profileId), () => this.attentionTarget());
    if (terminal.activityState === "working" || terminal.activityState === "needs_input" || terminal.activityState === "done" || terminal.activityState === "failed" || terminal.activityState === "parked") worker.setState(terminal.activityState);
    else worker.setState("idle");
    this.workers.set(terminal.id, worker);
    this.office.scene.add(worker.figure.root);
    return worker;
  }

  async hire(profile: AgentProfile, seat: Seat, cwd: string, icon = defaultModelIcon(profile.id)): Promise<Terminal> {
    return this.api.request<Terminal>("spawn_terminal", {
      request: {
        label: "",
        profileId: profile.id,
        command: profile.command,
        args: profile.args || [],
        cwd,
        env: {},
        role: profile.role,
        accent: profile.accent,
        icon,
        swarmX: seat.x,
        swarmY: seat.z,
        cols: 100,
        rows: 28
      }
    });
  }

  setState(terminalId: string, state: WorkerState): void {
    this.workers.get(terminalId)?.setState(state);
  }

  updateMetadata(terminal: Terminal): void { this.workers.get(terminal.id)?.updateMetadata(terminal.title, terminal.icon || ""); }

  write(terminalId: string, data: string): void {
    this.workers.get(terminalId)?.write(data);
  }

  setDesktopPreview(terminalId: string, preview: DesktopPreview): void { this.workers.get(terminalId)?.setDesktopPreview(preview); }

  writeDesktop(terminalId: string, key: string, data: string): void { this.workers.get(terminalId)?.writeDesktop(key, data); }

  resize(terminalId: string, cols: number, rows: number): void {
    this.workers.get(terminalId)?.resizeTerminal(cols, rows);
  }

  remove(terminalId: string): void {
    const worker = this.workers.get(terminalId);
    if (!worker) return;
    worker.dispose();
    this.office.release(terminalId);
    this.workers.delete(terminalId);
  }

  sendHome(terminalId: string, finish: () => Promise<boolean>, keepComputer = false): void {
    const worker = this.workers.get(terminalId);
    if (!worker || worker.isLeaving) return;
    const root = worker.figure.root.position;
    if (!keepComputer) this.office.setExitDoorOpen(true);
    worker.depart(this.office.findExitRoute(root.x, root.z), async () => {
      const removed = await finish();
      if (!keepComputer) this.office.setExitDoorOpen(false);
      return removed;
    }, keepComputer);
  }

  setOfficeClosed(closed: boolean): void {
    if (closed !== this.officeClosed) {
      this.officeClosed = closed;
      if (closed) { this.returnDoorOpen = false; this.office.setExitDoorOpen(true); }
      else { this.returnDoorOpen ||= this.all.some((worker) => worker.isHomeForDay || worker.isReturningToOffice); this.office.setExitDoorOpen(this.returnDoorOpen); }
    }
    for (const worker of this.all) {
      if (closed) {
        if (worker.isLeaving || worker.isHomeForDay) continue;
        this.sendHome(worker.terminalId, async () => true, true);
      } else worker.returnToOffice();
    }
  }

  update(dt: number): void {
    this.breakCooldown -= dt;
    const workers = this.all;
    if (!this.officeClosed) for (const worker of workers) if (worker.isHomeForDay) {
      if (!this.returnDoorOpen) { this.returnDoorOpen = true; this.office.setExitDoorOpen(true); }
      worker.returnToOffice();
    }
    if (this.breakCooldown <= 0 && !workers.some((worker) => worker.onBreak)) {
      const resting = workers.filter((worker) => worker.state === "idle");
      const available = resting.length ? resting : workers.filter((worker) => worker.state === "working");
      if (available.length) {
        const activities: ("cooler" | "breakroom")[] = ["cooler", "breakroom"];
        const choices = activities.filter((activity) => activity !== this.lastActivity);
        const activity = choices[Math.floor(Math.random() * choices.length)];
        available[Math.floor(Math.random() * available.length)].startBreak(activity);
        this.lastActivity = activity;
        this.breakCooldown = 90 + Math.random() * 90;
      }
    }
    const size = this.office.renderer.getSize(new THREE.Vector2());
    for (const worker of workers) {
      worker.update(dt);
      worker.place(this.office.camera, size.x, size.y);
    }
    if (this.returnDoorOpen) {
      if (workers.some((worker) => worker.isHomeForDay || worker.isReturningToOffice)) this.office.setExitDoorOpen(true);
      else { this.returnDoorOpen = false; this.office.setExitDoorOpen(false); }
    }
  }
}
