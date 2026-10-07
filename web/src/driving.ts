import * as THREE from "three";
export type VehicleKind = "sedan" | "coupe" | "wagon" | "pickup";
export interface VehiclePose { x: number; z: number; yaw: number; speed: number; steer: number }
export interface DriveCar { id: number; name: string; kind: VehicleKind; root: THREE.Group; collider: THREE.Box3; wheels: { pivot: THREE.Group; spin: THREE.Group; front: boolean }[]; wheelRadius: number; wheelbase: number; maxSpeed: number }
export interface DrivingHooks { entered(car: DriveCar, pose: VehiclePose): void; moved(car: DriveCar, pose: VehiclePose): void; exited(car: DriveCar, position: { x: number; y: number; z: number; yaw: number }): void; horn(car: DriveCar): void }
const STREET_Y = -3.6;
export const GARAGE_DRIVEWAY = { minX: -6.8, maxX: -3, minZ: 10.4, maxZ: 18.4 };
export function registerVehicleSurface(scene: THREE.Scene, mesh: THREE.Object3D): void { const surfaces = (scene.userData.vehicleSurfaces ??= []) as THREE.Box3[]; surfaces.push(new THREE.Box3().setFromObject(mesh)); }
export function vehicleTerrainHeight(scene: THREE.Scene, x: number, z: number): number { let height = -Infinity; for (const box of (scene.userData.vehicleSurfaces as THREE.Box3[] | undefined) ?? []) if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) height = Math.max(height, box.max.y); return height === -Infinity ? STREET_Y : height; }
export function vehicleSurfaceHeight(scene: THREE.Scene, pose: Pick<VehiclePose, "x" | "z" | "yaw">): number { let height = 0; const sin = Math.sin(pose.yaw), cos = Math.cos(pose.yaw); for (const x of [-0.87, 0.87]) for (const z of [-1.08, 1.08]) height += vehicleTerrainHeight(scene, pose.x + x * cos + z * sin, pose.z - x * sin + z * cos); return height / 4; }
export function placeVehicleOnSurface(scene: THREE.Scene, car: DriveCar): void {
  const heights = (car.root.userData.contactHeights ??= new Float64Array(4)) as Float64Array, sin = Math.sin(car.root.rotation.y), cos = Math.cos(car.root.rotation.y);
  let front = 0, rear = 0, positive = 0, negative = 0;
  for (let i = 0; i < car.wheels.length; i++) { const wheel = car.wheels[i], x = wheel.pivot.position.x, z = wheel.pivot.position.z, height = vehicleTerrainHeight(scene, car.root.position.x + x * cos + z * sin, car.root.position.z - x * sin + z * cos); heights[i] = height; if (wheel.front) front += height / 2; else rear += height / 2; if (x > 0) positive += height / 2; else negative += height / 2; }
  car.root.position.y = (front + rear) / 2; car.root.rotation.order = "YXZ"; car.root.rotation.x = -Math.atan2(front - rear, car.wheelbase); car.root.rotation.z = Math.atan2(positive - negative, 1.74);
  const sinPitch = Math.sin(car.root.rotation.x), cosPitch = Math.cos(car.root.rotation.x), sinRoll = Math.sin(car.root.rotation.z), cosRoll = Math.cos(car.root.rotation.z);
  for (let i = 0; i < car.wheels.length; i++) { const wheel = car.wheels[i], steer = wheel.pivot.rotation.y, axisY = cosPitch * sinRoll * Math.cos(steer) + sinPitch * Math.sin(steer), extent = car.wheelRadius * Math.sqrt(Math.max(0, 1 - axisY * axisY)) + 0.11 * Math.abs(axisY); wheel.pivot.position.y = (heights[i] + extent - car.root.position.y - cosPitch * sinRoll * wheel.pivot.position.x + sinPitch * wheel.pivot.position.z) / (cosPitch * cosRoll); }
  updateVehicleBounds(car);
}
export function animateVehicle(car: DriveCar, distance: number, steer = 0): void { for (const wheel of car.wheels) { wheel.spin.rotation.x = (wheel.spin.rotation.x + distance / car.wheelRadius) % (Math.PI * 2); wheel.pivot.rotation.y = wheel.front ? steer : 0; } }
export function updateVehicleBounds(car: DriveCar): void { const sin = Math.abs(Math.sin(car.root.rotation.y)), cos = Math.abs(Math.cos(car.root.rotation.y)), x = car.root.position.x, y = car.root.position.y, z = car.root.position.z, halfX = 1.08 * cos + 1.9 * sin, halfZ = 1.9 * cos + 1.08 * sin, tilt = Math.abs(Math.sin(car.root.rotation.x)) * 1.9 + Math.abs(Math.sin(car.root.rotation.z)) * 1.08; car.collider.min.set(x - halfX, y - tilt, z - halfZ); car.collider.max.set(x + halfX, y + 1.56 + tilt, z + halfZ); }
export function vehiclePoint(pose: Pick<VehiclePose, "x" | "z" | "yaw">, x: number, z: number): { x: number; z: number } { const sin = Math.sin(pose.yaw), cos = Math.cos(pose.yaw); return { x: pose.x + x * cos + z * sin, z: pose.z - x * sin + z * cos }; }
export function vehicleOverlaps(pose: Pick<VehiclePose, "x" | "z" | "yaw">, box: THREE.Box3): boolean { const sin = Math.sin(pose.yaw), cos = Math.cos(pose.yaw), dx = (box.min.x + box.max.x) / 2 - pose.x, dz = (box.min.z + box.max.z) / 2 - pose.z, ex = (box.max.x - box.min.x) / 2, ez = (box.max.z - box.min.z) / 2; return Math.abs(dx) < 1.08 * Math.abs(cos) + 1.9 * Math.abs(sin) + ex && Math.abs(dz) < 1.08 * Math.abs(sin) + 1.9 * Math.abs(cos) + ez && Math.abs(dx * cos - dz * sin) < 1.08 + ex * Math.abs(cos) + ez * Math.abs(sin) && Math.abs(dx * sin + dz * cos) < 1.9 + ex * Math.abs(sin) + ez * Math.abs(cos); }
export class DrivingController {
  readonly cars: DriveCar[];
  private keys = new Set<string>();
  private selected: DriveCar | null = null;
  private currentPose: VehiclePose | null = null;
  private hornAt = -Infinity;
  private clock = 0;
  constructor(private scene: THREE.Scene, private colliders: THREE.Box3[], private hooks: DrivingHooks) { this.cars = (scene.userData.driveCars as DriveCar[] | undefined) ?? []; }
  get active(): boolean { return this.selected !== null; }
  get current(): DriveCar | null { return this.selected; }
  get pose(): VehiclePose | null { return this.currentPose && { ...this.currentPose }; }
  cancel(): DriveCar | null { const car = this.selected; if (car) animateVehicle(car, 0, 0); this.selected = null; this.currentPose = null; this.keys.clear(); return car; }
  correct(pose: VehiclePose): void { if (!this.selected || !this.currentPose) return; Object.assign(this.currentPose, pose); this.selected.root.position.set(pose.x, vehicleSurfaceHeight(this.scene, pose), pose.z); this.selected.root.rotation.y = pose.yaw; animateVehicle(this.selected, 0, pose.steer); placeVehicleOnSurface(this.scene, this.selected); this.hooks.moved(this.selected, { ...this.currentPose }); }
  nearest(x: number, z: number, y: number): DriveCar | null { if (this.active) return null; let nearest: DriveCar | null = null, distance = 3; for (const car of this.cars) { const next = Math.hypot(x - car.root.position.x, z - car.root.position.z); if (Math.abs(y - car.root.position.y) < 1.1 && next < distance) { nearest = car; distance = next; } } return nearest; }
  enter(id: number): boolean { if (this.active) return false; const car = this.cars.find((candidate) => candidate.id === id); if (!car) return false; placeVehicleOnSurface(this.scene, car); this.selected = car; this.currentPose = { x: car.root.position.x, z: car.root.position.z, yaw: car.root.rotation.y, speed: 0, steer: 0 }; this.keys.clear(); this.hooks.entered(car, { ...this.currentPose }); return true; }
  startArrival(): boolean { if (this.active || !this.cars.length) return false; const car = this.cars[0], pose = { x: -54, z: 20.3, yaw: Math.PI / 2, speed: 0, steer: 0 }; if (!this.fits(pose, car)) return false; car.root.position.set(pose.x, vehicleSurfaceHeight(this.scene, pose), pose.z); car.root.rotation.y = pose.yaw; placeVehicleOnSurface(this.scene, car); return this.enter(car.id); }
  exit(): boolean {
    const car = this.selected, pose = this.currentPose; if (!car || !pose) return false;
    for (const [x, z] of [[1.8, 0], [-1.8, 0], [0, -2.65], [0, 2.65]]) { const point = vehiclePoint(pose, x, z); if (!this.exitFits(point.x, point.z, car)) continue; pose.speed = 0; animateVehicle(car, 0, 0); this.selected = null; this.currentPose = null; this.keys.clear(); this.hooks.exited(car, { ...point, y: vehicleTerrainHeight(this.scene, point.x, point.z), yaw: pose.yaw }); return true; }
    this.keys.clear(); pose.speed = 0; return false;
  }
  handleKey(event: KeyboardEvent, down: boolean): boolean { if (!this.active) return false; const key = event.key.toLowerCase(); if (!["w", "a", "s", "d", " ", "e", "j"].includes(key)) return false; if (down) this.keys.add(key); else this.keys.delete(key); if (down && !event.repeat && key === "e") this.exit(); if (down && !event.repeat && key === "j" && this.selected && this.clock - this.hornAt > 0.35) { this.hornAt = this.clock; this.hooks.horn(this.selected); } event.preventDefault(); return true; }
  clearInput(): void { this.keys.clear(); }
  update(dt: number, enabled = true): void {
    this.clock += dt; const car = this.selected, pose = this.currentPose; if (!car || !pose) return; if (!enabled) this.keys.clear();
    const gas = (this.keys.has("w") ? 1 : 0) - (this.keys.has("s") ? 1 : 0), turn = (this.keys.has("a") ? 1 : 0) - (this.keys.has("d") ? 1 : 0), braking = this.keys.has(" ") || !enabled, total = Math.min(Math.max(dt, 0), 0.15), steps = Math.max(1, Math.ceil(Math.max(Math.abs(pose.speed), 3) * total / 0.15)), step = total / steps;
    for (let i = 0; i < steps; i++) {
      const target = turn * 0.58 / (1 + Math.abs(pose.speed) / 11); pose.steer += THREE.MathUtils.clamp(target - pose.steer, -2.5 * step, 2.5 * step);
      if (braking || gas && Math.sign(gas) !== Math.sign(pose.speed) && Math.abs(pose.speed) > 0.15) pose.speed -= Math.sign(pose.speed) * Math.min(Math.abs(pose.speed), 18 * step);
      else if (gas) pose.speed = THREE.MathUtils.clamp(pose.speed + gas * (gas > 0 ? 7.2 : 4.5) * step, -6, car.maxSpeed);
      else pose.speed -= Math.sign(pose.speed) * Math.min(Math.abs(pose.speed), 1.8 * step);
      const distance = pose.speed * step, turnAngle = Math.tan(pose.steer) * distance / car.wheelbase, heading = pose.yaw + turnAngle / 2, next = { ...pose, x: pose.x + Math.sin(heading) * distance, z: pose.z + Math.cos(heading) * distance, yaw: Math.atan2(Math.sin(pose.yaw + turnAngle), Math.cos(pose.yaw + turnAngle)) };
      if (!this.fits(next, car)) { pose.speed = 0; continue; } Object.assign(pose, next); animateVehicle(car, distance, pose.steer);
    }
    car.root.position.set(pose.x, vehicleSurfaceHeight(this.scene, pose), pose.z); car.root.rotation.y = pose.yaw; placeVehicleOnSurface(this.scene, car); this.hooks.moved(car, { ...pose });
  }
  private fits(pose: VehiclePose, car: DriveCar): boolean { for (const [x, z] of [[-1.08, -1.9], [1.08, -1.9], [-1.08, 1.9], [1.08, 1.9]]) { const point = vehiclePoint(pose, x, z); if (Math.abs(point.x) > 78 || Math.abs(point.z) > 78) return false; } const height = vehicleSurfaceHeight(this.scene, pose); for (const box of this.colliders) if (box !== car.collider && box.max.y > height + 0.08 && box.min.y < height + 1.5 && vehicleOverlaps(pose, box)) return false; for (const vehicle of (this.scene.userData.trafficCars as DriveCar[] | undefined) ?? []) { const box = vehicle.collider; if (box.max.y > height + 0.08 && box.min.y < height + 1.5 && vehicleOverlaps(pose, box)) return false; } return true; }
  private exitFits(x: number, z: number, car: DriveCar): boolean { if (Math.abs(x) > 78 || Math.abs(z) > 78) return false; const height = vehicleTerrainHeight(this.scene, x, z); for (const box of this.colliders) if (box !== car.collider && box.max.y > height + 0.12 && box.min.y < height + 1.4 && x + 0.34 > box.min.x && x - 0.34 < box.max.x && z + 0.34 > box.min.z && z - 0.34 < box.max.z) return false; return true; }
}
