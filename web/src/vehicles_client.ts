import * as THREE from "three";
import type { Api } from "./api";
import type { Office } from "./office";
import { DrivingController, animateVehicle, updateVehicleBounds, type DrivingHooks, type VehiclePose } from "./driving";
export interface VehicleState extends VehiclePose { id: number; driver: string; revision: number }
export class VehicleCoordinator {
  readonly driving: DrivingController;
  private readonly states = new Map<number, VehicleState>();
  private pending = false;
  private movePending = false;
  private moveRequest?: Promise<void>;
  private nextMove = 0;
  private sequence = 0;
  private nextError = 0;
  private connected = true;
  private generation = 0;
  private exiting: number | null = null;
  private lastMove?: VehiclePose;
  constructor(private readonly api: Api, private readonly office: Office, private readonly connectionId: () => string, private readonly hooks: DrivingHooks & { lost: () => void; error: (message: string) => void }, private readonly canDrive: boolean) {
    this.driving = new DrivingController(office.scene, office.colliders, { entered: hooks.entered, moved: hooks.moved, horn: hooks.horn, exited: (car, position) => { const pose = { x: car.root.position.x, z: car.root.position.z, yaw: car.root.rotation.y, speed: 0, steer: 0 }, generation = this.generation; this.pending = true; this.exiting = car.id; void Promise.resolve(this.moveRequest).then(() => { if (generation !== this.generation || !this.connected) throw new Error("Vehicle connection changed"); return this.api.request<VehicleState>("vehicle_exit", { id: car.id, pose }); }).then((state) => { if (generation === this.generation) this.receive([state]); }).catch((problem) => { if (generation !== this.generation) return; this.report(problem); const accepted = this.states.get(car.id); if (accepted?.driver === this.connectionId()) { this.driving.enter(car.id); this.driving.correct({ ...accepted, speed: 0, steer: 0 }); } }).finally(() => { if (generation === this.generation) { this.pending = false; this.exiting = null; } }); this.hooks.exited(car, position); } });
    api.on("vehicle-state", (states: VehicleState[]) => this.receive(states));
    api.on("__closed", () => { this.connected = false; this.resetConnection(); });
    api.on("__reconnected", () => { this.connected = true; this.resetConnection(); void this.refresh(); });
  }
  get cars(): { id: number; name: string; kind: string; available: boolean }[] { return this.driving.cars.map((car) => ({ id: car.id, name: car.name, kind: car.kind, available: this.canDrive && this.connected && !this.pending && !this.states.get(car.id)?.driver })); }
  async refresh(): Promise<void> { if (!this.connected) return; try { this.receive(await this.api.request<VehicleState[]>("vehicles_get")); } catch (problem) { this.report(problem); } }
  async enter(id: number, arrival = false): Promise<void> {
    if (!this.canDrive) throw new Error("Guests cannot drive vehicles");
    if (!this.connected || !this.connectionId()) throw new Error("Office connection unavailable");
    if (this.pending || this.driving.active) throw new Error("A vehicle is already active");
    if (this.office.hasHeldObject || this.office.coffee.hasCup) throw new Error("Put down what you are holding before driving");
    const car = this.driving.cars.find((candidate) => candidate.id === id);
    if (!car) throw new Error("Vehicle is unavailable");
    this.pending = true;
    const generation = this.generation;
    try { const state = await this.api.request<VehicleState>("vehicle_enter", { id, arrival }); if (generation !== this.generation || !this.connected || state.driver !== this.connectionId()) throw new Error("Vehicle claim connection changed"); this.receive([state]); car.root.position.set(state.x, -3.6, state.z); car.root.rotation.y = state.yaw; updateVehicleBounds(car); this.sequence = 0; this.nextMove = 0; this.lastMove = { ...state }; if (!this.driving.enter(id)) { await this.api.request("vehicle_exit", { id }); throw new Error("Unable to enter vehicle"); } }
    finally { if (generation === this.generation) this.pending = false; }
  }
  update(dt: number, enabled: boolean): void {
    const own = this.driving.current;
    for (const car of this.driving.cars) {
      const state = this.states.get(car.id);
      if (!state || car === own || car.id === this.exiting) continue;
      const beforeX = car.root.position.x, beforeZ = car.root.position.z, distance = Math.hypot(state.x - beforeX, state.z - beforeZ), blend = !state.driver || distance > 8 ? 1 : 1 - Math.exp(-dt * 14);
      car.root.position.x += (state.x - beforeX) * blend; car.root.position.z += (state.z - beforeZ) * blend; car.root.rotation.y += (THREE.MathUtils.euclideanModulo(state.yaw - car.root.rotation.y + Math.PI, Math.PI * 2) - Math.PI) * blend;
      animateVehicle(car, Math.hypot(car.root.position.x - beforeX, car.root.position.z - beforeZ) * (state.speed < 0 ? -1 : 1), state.steer); updateVehicleBounds(car);
    }
    this.driving.update(dt, enabled);
    const car = this.driving.current, pose = this.driving.pose, now = performance.now();
    if (!this.connected || !car || !pose || this.movePending || now < this.nextMove || this.lastMove && pose.x === this.lastMove.x && pose.z === this.lastMove.z && pose.yaw === this.lastMove.yaw && pose.speed === this.lastMove.speed && pose.steer === this.lastMove.steer) return;
    this.movePending = true; this.nextMove = now + 100;
    const generation = this.generation; this.lastMove = { ...pose };
    this.moveRequest = this.api.request<VehicleState>("vehicle_move", { id: car.id, pose, seq: ++this.sequence }).then((state) => { if (generation === this.generation) this.receive([state]); }).catch((problem) => { if (generation !== this.generation || this.driving.current?.id !== car.id) return; const accepted = this.states.get(car.id); if (accepted) { this.driving.correct({ ...accepted, speed: 0, steer: 0 }); this.lastMove = { ...accepted, speed: 0, steer: 0 }; } this.driving.clearInput(); this.report(problem); }).finally(() => { if (generation === this.generation) { this.movePending = false; this.moveRequest = undefined; } });
  }
  private receive(states: readonly VehicleState[]): void {
    if (!Array.isArray(states)) return;
    for (const state of states) {
      if (!state || !Number.isInteger(state.id) || state.id < 0 || state.id >= 4 || typeof state.driver !== "string" || !Number.isInteger(state.revision) || state.revision < 0 || ![state.x, state.z, state.yaw, state.speed, state.steer].every(Number.isFinite)) continue;
      const previous = this.states.get(state.id);
      if (previous && state.revision <= previous.revision) continue;
      this.states.set(state.id, { ...state });
      if (this.driving.current?.id === state.id && state.driver !== this.connectionId()) { this.driving.cancel(); this.hooks.lost(); }
    }
  }
  private resetConnection(): void { this.generation++; this.states.clear(); this.sequence = 0; this.pending = false; this.movePending = false; this.moveRequest = undefined; this.exiting = null; this.lastMove = undefined; if (this.driving.active) { this.driving.cancel(); this.hooks.lost(); } }
  private report(problem: unknown): void { const now = performance.now(); if (now < this.nextError) return; this.nextError = now + 5000; this.hooks.error(problem instanceof Error ? problem.message : String(problem)); }
}
