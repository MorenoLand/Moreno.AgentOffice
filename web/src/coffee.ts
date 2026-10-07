import * as THREE from "three";
import type { Office } from "./office";
import { surfaceMaterial } from "./materials";
export class CoffeeStation {
  readonly machinePosition: THREE.Vector3;
  readonly binPosition = new THREE.Vector3(8.9, 0, -9.94);
  private readonly cup = new THREE.Group();
  private readonly liquid = new THREE.Mesh(new THREE.CircleGeometry(0.052, 32), surfaceMaterial(0x382318, 0.22));
  private readonly pour = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1, 12), surfaceMaterial(0x6b432a, 0.3));
  private readonly steam: THREE.Points;
  private readonly lid = new THREE.Group();
  private readonly dispense = new THREE.Vector3();
  private readonly nozzle = new THREE.Vector3();
  private readonly pourEnd = new THREE.Vector3();
  private readonly pourDirection = new THREE.Vector3();
  private readonly pourUp = new THREE.Vector3(0, 1, 0);
  private readonly thrownStart = new THREE.Vector3();
  private readonly thrownEnd = new THREE.Vector3();
  private phase: "idle" | "brewing" | "ready" | "discarding" = "idle";
  private held = false;
  private amount = 0;
  private started = 0;
  private sip = 0;
  private elapsed = 0;
  constructor(private readonly office: Office, machine: THREE.Group) {
    this.machinePosition = machine.position.clone();
    machine.updateMatrixWorld(true);
    this.dispense.copy(machine.children[0].localToWorld(new THREE.Vector3(0, 0.086, 0.25)));
    this.nozzle.copy(machine.children[0].localToWorld(new THREE.Vector3(0, 0.18, 0.25))); this.cup.scale.setScalar(0.5);
    machine.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material) || !["White", "Dark"].includes(mesh.material.name)) return;
      const geometry = mesh.geometry.clone(), positions = geometry.getAttribute("position"), indices: number[] = [], index = geometry.getIndex();
      const inside = (vertex: number) => positions.getX(vertex) >= -0.051 && positions.getX(vertex) <= 0.084 && positions.getY(vertex) >= 0.085 && positions.getY(vertex) <= 0.158 && positions.getZ(vertex) >= 0.199 && positions.getZ(vertex) <= 0.301;
      for (let i = 0, count = index?.count ?? positions.count; i < count; i += 3) { const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2; if (!(inside(a) && inside(b) && inside(c))) indices.push(a, b, c); }
      geometry.setIndex(indices); geometry.computeBoundingSphere(); mesh.geometry = geometry;
    });
    const paper = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.044, 0.14, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xf4eee1, roughness: 0.86, side: THREE.DoubleSide })); paper.position.y = 0.07;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.053, 0.049, 0.038, 32, 1, true), surfaceMaterial(0x608d83, 0.92)); band.position.y = 0.065;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.059, 0.003, 8, 32), surfaceMaterial(0xf4eee1, 0.8)); rim.rotation.x = Math.PI / 2; rim.position.y = 0.14;
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.044, 24), surfaceMaterial(0xf4eee1, 0.86)); bottom.rotation.x = -Math.PI / 2; bottom.position.y = 0.002;
    this.liquid.rotation.x = -Math.PI / 2; this.liquid.position.y = 0.02;
    this.cup.add(paper, band, rim, bottom, this.liquid); this.cup.visible = false; this.cup.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
    const vapor = document.createElement("canvas"); vapor.width = vapor.height = 32;
    const context = vapor.getContext("2d")!, gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16); gradient.addColorStop(0, "rgba(255,255,255,.65)"); gradient.addColorStop(1, "rgba(255,255,255,0)"); context.fillStyle = gradient; context.fillRect(0, 0, 32, 32);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(18 * 3), 3));
    this.steam = new THREE.Points(geometry, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(vapor), color: 0xf2eae1, size: 0.075, opacity: 0.23, transparent: true, depthWrite: false })); this.steam.frustumCulled = false; this.cup.add(this.steam);
    this.pour.visible = false; this.office.scene.add(this.cup, this.pour);
    const bin = new THREE.Group(), shell = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.22, 0.64, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x526166, roughness: 0.48, metalness: 0.45, side: THREE.DoubleSide })); shell.position.y = 0.32;
    const opening = new THREE.Mesh(new THREE.CircleGeometry(0.235, 32), surfaceMaterial(0x171d1e)); opening.rotation.x = -Math.PI / 2; opening.position.y = 0.58;
    const binRim = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.018, 8, 32), surfaceMaterial(0x879594, 0.3, 0.65)); binRim.rotation.x = Math.PI / 2; binRim.position.y = 0.64;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.025, 32), surfaceMaterial(0x879594, 0.3, 0.65)); top.position.z = 0.22; this.lid.position.set(0, 0.66, -0.22); this.lid.add(top);
    bin.add(shell, opening, binRim, this.lid); bin.position.copy(this.binPosition); bin.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } }); this.office.scene.add(bin);
    this.office.colliders.push(new THREE.Box3(new THREE.Vector3(this.binPosition.x - 0.27, 0, this.binPosition.z - 0.27), new THREE.Vector3(this.binPosition.x + 0.27, 0.69, this.binPosition.z + 0.27)));
  }
  get hasCup(): boolean { return this.held; }
  get drinking(): boolean { return this.sip > 0; }
  get state(): string { return this.phase; }
  nearMachine(x: number, z: number, y: number): boolean { return Math.abs(y) < 0.8 && Math.hypot(x - this.machinePosition.x, z - this.machinePosition.z) < 1.45; }
  nearBin(x: number, z: number, y: number): boolean { return Math.abs(y) < 0.8 && Math.hypot(x - this.binPosition.x, z - this.binPosition.z) < 1.25; }
  nearCup(x: number, z: number, y: number): boolean { return this.phase === "ready" && !this.held && Math.abs(y - this.cup.position.y) < 1.5 && Math.hypot(x - this.cup.position.x, z - this.cup.position.z) < 1.25; }
  hint(x: number, z: number, y: number): { label: string; action: string } | null {
    if (this.held) return { label: this.sip > 0 ? "Drinking coffee" : this.amount > 0 ? "Coffee" : "Empty cup — take it to the bin", action: this.nearBin(x, z, y) ? "throw cup away" : this.amount > 0 ? "drink coffee" : "empty cup" };
    if (this.nearCup(x, z, y)) return { label: this.amount > 0 ? "Fresh coffee" : "Empty cup", action: "pick up cup" };
    if (this.nearMachine(x, z, y)) return { label: this.phase === "brewing" ? "Brewing coffee" : "Coffee machine", action: this.phase === "idle" ? "make coffee" : this.phase === "brewing" ? "brewing" : "pick up the ready cup" };
    return null;
  }
  interact(x: number, z: number, y: number): string | null {
    if (this.phase === "discarding") return null;
    this.office.invalidateShadows();
    if (this.held) {
      if (this.sip > 0) return "Drinking coffee";
      if (this.nearBin(x, z, y)) { this.office.scene.attach(this.cup); this.thrownStart.copy(this.cup.position); this.thrownEnd.copy(this.binPosition).add(new THREE.Vector3(0, 0.32, 0)); this.phase = "discarding"; this.held = false; this.started = performance.now(); return "Cup thrown away"; }
      if (this.amount <= 0) return "The cup is empty — put it in the waste bin";
      this.sip = 0.001; return "Drinking coffee";
    }
    if (this.nearCup(x, z, y)) { if (this.office.hasHeldObject) return "Put down the object before picking up coffee"; this.office.camera.add(this.cup); this.cup.position.set(0.24, -0.28, -0.56); this.cup.rotation.set(0, 0, 0); this.held = true; return "Coffee picked up"; }
    if (this.nearMachine(x, z, y)) { if (this.phase !== "idle") return this.phase === "brewing" ? "Coffee is brewing" : "Pick up the ready coffee first"; this.phase = "brewing"; this.started = performance.now(); this.amount = 0; this.cup.position.copy(this.dispense); this.cup.rotation.set(0, 0, 0); this.cup.visible = true; this.liquid.visible = true; this.pour.visible = true; return "Brewing coffee"; }
    return null;
  }
  drop(x: number, z: number, y: number, yaw: number): boolean { if (!this.held || this.sip > 0) return false; for (const angle of [yaw, yaw + 0.8, yaw - 0.8]) { const nextX = x + Math.sin(angle) * 0.7, nextZ = z + Math.cos(angle) * 0.7, height = this.office.walkSurfaceAt(nextX, nextZ, y) + 0.006, bounds = new THREE.Box3(new THREE.Vector3(nextX - 0.065, height, nextZ - 0.065), new THREE.Vector3(nextX + 0.065, height + 0.14, nextZ + 0.065)); if (this.office.colliders.some((box) => box.max.y > height + 0.01 && box.intersectsBox(bounds))) continue; this.office.scene.attach(this.cup); this.cup.position.set(nextX, height, nextZ); this.cup.rotation.set(0, angle, 0); this.held = false; this.office.invalidateShadows(); return true; } return false; }
  update(dt: number, now = performance.now()): void {
    this.elapsed += dt;
    if (this.phase === "brewing") { this.amount = THREE.MathUtils.clamp((now - this.started) / 3400, 0, 1); if (this.amount >= 1) { this.phase = "ready"; this.pour.visible = false; } }
    if (this.held && this.sip > 0) { this.sip += dt; const progress = Math.min(1, this.sip / 1.2), lift = Math.sin(progress * Math.PI); this.cup.position.set(0.24 - lift * 0.16, -0.28 + lift * 0.17, -0.56 + lift * 0.34); this.cup.rotation.z = lift * 0.15; if (progress >= 1) { this.amount = Math.max(0, this.amount - 0.34); this.sip = 0; this.cup.rotation.z = 0; } }
    if (this.phase === "discarding") { const progress = THREE.MathUtils.clamp((now - this.started) / 650, 0, 1); this.lid.rotation.x = -Math.sin(progress * Math.PI) * 1.3; this.cup.position.lerpVectors(this.thrownStart, this.thrownEnd, progress); this.cup.position.y += Math.sin(progress * Math.PI) * 0.42; this.cup.rotation.x = progress * 5; if (progress >= 1) { this.cup.visible = false; this.phase = "idle"; this.amount = 0; this.lid.rotation.x = 0; this.office.invalidateShadows(); } }
    this.liquid.visible = this.amount > 0.005; this.liquid.position.y = 0.014 + this.amount * 0.112; this.liquid.scale.setScalar(0.77 + this.amount * 0.23);
    if (this.pour.visible) { this.pourEnd.copy(this.liquid.position); this.cup.localToWorld(this.pourEnd); this.pour.position.copy(this.nozzle).add(this.pourEnd).multiplyScalar(0.5); this.pour.scale.y = this.nozzle.distanceTo(this.pourEnd); this.pour.quaternion.setFromUnitVectors(this.pourUp, this.pourDirection.copy(this.nozzle).sub(this.pourEnd).normalize()); }
    this.steam.visible = this.cup.visible && this.amount > 0.01 && this.phase !== "discarding";
    if (this.steam.visible) { const positions = this.steam.geometry.getAttribute("position") as THREE.BufferAttribute; for (let i = 0; i < positions.count; i++) { const rise = (this.elapsed * 0.32 + i / positions.count) % 1; positions.setXYZ(i, Math.sin(i * 2.7 + this.elapsed) * 0.025 * rise, 0.14 + rise * 0.3, Math.cos(i * 1.9 + this.elapsed * 0.8) * 0.025 * rise); } positions.needsUpdate = true; }
  }
}
