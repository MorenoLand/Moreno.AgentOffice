import * as THREE from "three";
import { surfaceMaterial } from "./materials";

export const ELEVATOR_LAYOUT = { x: -12.5, z: -8.2, width: 2.4, depth: 2.6, floorHeight: -3.6, doorZ: -6.9 } as const;

type Landing = { y: number; open: number; target: number; collider: THREE.Box3; doors: [THREE.Group, THREE.Group] };

export class OfficeElevator {
  readonly position = { x: ELEVATOR_LAYOUT.x, z: ELEVATOR_LAYOUT.doorZ + 0.8 };
  readonly colliders: THREE.Box3[] = [];
  readonly walkSurfaces: { minX: number; maxX: number; minZ: number; maxZ: number; height: number }[] = [];
  readonly carPosition = { x: ELEVATOR_LAYOUT.x, z: ELEVATOR_LAYOUT.z };
  private car = new THREE.Group();
  private carDoors: [THREE.Mesh, THREE.Mesh];
  private carDoorOpen = 0;
  private carDoorTarget = 0;
  private landings: [Landing, Landing];
  private floor = 0;
  private destination: number | null = null;
  private resolveRide: ((floor: number) => void) | null = null;

  constructor(private scene: THREE.Scene) {
    const { x, z, width, depth, floorHeight, doorZ } = ELEVATOR_LAYOUT;
    const top = 7.3, bottom = floorHeight;
    const steel = surfaceMaterial(0x8997a3, 0.29, 0.78);
    const dark = surfaceMaterial(0x46535e, 0.42, 0.52);
    const brass = surfaceMaterial(0xd6b46d, 0.32, 0.72);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xc8e1e5, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.08 });
    const box = (w: number, h: number, d: number, material: THREE.Material, px: number, py: number, pz: number, collision = false) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(px, py, pz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      if (collision) this.colliders.push(new THREE.Box3().setFromObject(mesh).expandByScalar(0.025));
      return mesh;
    };
    for (const side of [-1, 1]) {
      const sx = x + side * (width / 2 - 0.07);
      box(0.14, 0.8, depth, dark, sx, bottom + 0.4, z, true);
      box(0.14, top - bottom - 0.8, depth, glass, sx, (top + bottom + 0.8) / 2, z, true);
      for (const end of [-1, 1]) box(0.07, top - bottom - 0.8, 0.09, steel, sx, (top + bottom + 0.8) / 2, z + end * (depth / 2 - 0.05));
    }
    box(width, 0.8, 0.14, dark, x, bottom + 0.4, z - depth / 2 + 0.07, true);
    box(width, top - bottom - 0.8, 0.14, glass, x, (top + bottom + 0.8) / 2, z - depth / 2 + 0.07, true);
    box(width + 0.18, 0.18, depth + 0.18, dark, x, top, z);
    box(width + 0.18, 0.18, depth + 0.18, dark, x, bottom, z);
    const makeLanding = (y: number): Landing => {
      const collider = new THREE.Box3(new THREE.Vector3(x - width / 2, y, doorZ - 0.12), new THREE.Vector3(x + width / 2, y + 2.3, doorZ + 0.12));
      this.colliders.push(collider);
      const doorMaterial = surfaceMaterial(0xb9c3be, 0.38, 0.64), doors = [-1, 1].map((side) => {
        const group = new THREE.Group(); group.position.set(x + side * 0.325, y + 1.14, doorZ);
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.65, 2.28, 0.065), doorMaterial); leaf.castShadow = true; leaf.receiveShadow = true; group.add(leaf);
        const window = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.88, 0.018), glass); window.position.set(0, 0.12, 0.041); group.add(window);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.035, 0.018), brass); rail.position.set(0, -0.85, 0.043); group.add(rail);
        scene.add(group); return group;
      }) as [THREE.Group, THREE.Group];
      for (const side of [-1, 1]) box(0.08, 2.42, 0.12, steel, x + side * 0.76, y + 1.21, doorZ + 0.03);
      box(1.6, 0.09, 0.14, steel, x, y + 2.4, doorZ + 0.03);
      const callPlate = box(0.18, 0.38, 0.045, brass, x + 0.9, y + 1.2, doorZ + 0.08);
      for (const offset of [-0.08, 0.08]) {
        const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 8, 24), steel); bezel.position.set(x + 0.9, y + 1.2 + offset, doorZ + 0.115); scene.add(bezel);
        const button = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), new THREE.MeshStandardMaterial({ color: offset < 0 ? 0x92d7b2 : 0xf6dfa3, emissive: offset < 0 ? 0x5a9f78 : 0xcaa95f, emissiveIntensity: 0.3, roughness: 0.25 }));
        button.scale.z = 0.38; button.position.set(x + 0.9, y + 1.2 + offset, doorZ + 0.112); scene.add(button);
      }
      callPlate.userData.kind = "elevator-call-panel";
      return { y, open: 0, target: 0, collider, doors };
    };
    this.landings = [makeLanding(0), makeLanding(floorHeight)];
    this.car.add(
      new THREE.Mesh(new THREE.BoxGeometry(2.32, 0.14, 2.52), dark),
      new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.35, 2.34), glass),
      new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.35, 2.34), glass),
      new THREE.Mesh(new THREE.BoxGeometry(2.32, 2.35, 0.09), glass),
      new THREE.Mesh(new THREE.BoxGeometry(2.32, 0.12, 2.52), glass)
    );
    this.car.children[0].position.y = 0.07;
    this.car.children[1].position.set(-1.12, 1.24, 0);
    this.car.children[2].position.set(1.12, 1.24, 0);
    this.car.children[3].position.set(0, 1.24, -1.22);
    this.car.children[4].position.set(0, 2.45, 0);
    const makeCarDoor = (side: number) => {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.65, 2.28, 0.045), glass);
      door.position.set(side * 0.325, 1.22, 1.19);
      door.userData.side = side;
      door.castShadow = true;
      this.car.add(door);
      return door;
    };
    this.carDoors = [makeCarDoor(-1), makeCarDoor(1)];
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.74, 0.34), brass);
    panel.position.set(1.04, 1.44, 0.66); panel.userData.kind = "elevator-floor-panel";
    this.car.add(panel);
    for (const offset of [-0.13, 0, 0.13]) {
      const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.007, 8, 24), steel); bezel.rotation.y = -Math.PI / 2; bezel.position.set(0.999, 1.35 + offset, 0.66); this.car.add(bezel);
      const button = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 14), new THREE.MeshStandardMaterial({ color: offset === 0 ? 0x8bd5b0 : 0xffe3a2, emissive: offset === 0 ? 0x579e77 : 0xcaae64, emissiveIntensity: 0.3, roughness: 0.25 }));
      button.scale.x = 0.3; button.position.set(0.997, 1.35 + offset, 0.66); this.car.add(button);
    }
    const handrail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.55, 24), steel);
    handrail.rotation.z = Math.PI / 2; handrail.position.set(0, 0.82, -1.08); this.car.add(handrail);
    for (const x of [-0.65, 0.65]) {
      const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.14, 16), steel); bracket.rotation.x = Math.PI / 2; bracket.position.set(x, 0.82, -1.15); this.car.add(bracket);
      const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.041, 0.018, 24), steel); mount.rotation.x = Math.PI / 2; mount.position.set(x, 0.82, -1.207); this.car.add(mount);
    }
    const indicator = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.1), new THREE.MeshBasicMaterial({ color: 0x83efad }));
    indicator.rotation.y = -Math.PI / 2; indicator.position.set(1, 1.73, 0.66);
    this.car.add(indicator);
    const cabinLight = new THREE.PointLight(0xffe4ab, 1.4, 5, 2);
    cabinLight.position.set(0, 2.2, 0);
    this.car.add(cabinLight);
    this.car.position.set(x, 0, z);
    this.scene.add(this.car);
    this.walkSurfaces.push({ minX: x - 1.16, maxX: x + 1.16, minZ: z - 1.26, maxZ: z + 1.26, height: 0 });
    this.walkSurfaces.push({ minX: x - 1.16, maxX: x + 1.16, minZ: z - 1.26, maxZ: z + 1.26, height: floorHeight });
    this.setLandingOpen(this.landings[0], true);
    this.setLandingOpen(this.landings[1], false);
  }

  get currentFloor(): number { return this.floor; }
  get moving(): boolean { return this.destination !== null; }
  get carY(): number { return this.car.position.y; }
  surfaceAt(x: number, z: number): number | undefined {
    return x >= this.carPosition.x - 1.16 && x <= this.carPosition.x + 1.16 && z >= this.carPosition.z - 1.26 && z <= this.carPosition.z + 1.26 ? this.carY : undefined;
  }

  ride(): Promise<number> {
    if (this.destination !== null) return Promise.resolve(this.destination);
    this.destination = this.floor === 0 ? ELEVATOR_LAYOUT.floorHeight : 0;
    this.setLandingOpen(this.landings[this.floor === 0 ? 0 : 1], false);
    return new Promise((resolve) => { this.resolveRide = resolve; });
  }

  update(dt: number): void {
    for (const landing of this.landings) {
      landing.open += (landing.target - landing.open) * Math.min(1, dt * 4);
      for (const door of landing.doors) { const side = door.position.x < ELEVATOR_LAYOUT.x ? -1 : 1; door.position.x = ELEVATOR_LAYOUT.x + side * (0.325 + landing.open * 0.49); }
      if (landing.open > 0.96) { landing.collider.min.y = landing.y + 2.4; landing.collider.max.y = landing.y + 2.3; }
      else { landing.collider.min.y = landing.y; landing.collider.max.y = landing.y + 2.3; }
    }
    this.carDoorOpen += (this.carDoorTarget - this.carDoorOpen) * Math.min(1, dt * 4);
    for (const panel of this.carDoors) {
      const side = panel.userData.side as number;
      panel.position.x = side * (0.325 + this.carDoorOpen * 0.49);
      panel.visible = this.carDoorOpen < 0.995;
    }
    if (this.destination === null) return;
    const current = this.floor === 0 ? this.landings[0] : this.landings[1];
    if (current.open > 0.04) return;
    this.car.position.y = THREE.MathUtils.damp(this.car.position.y, this.destination, 3.5, dt);
    if (Math.abs(this.car.position.y - this.destination) > 0.015) return;
    this.car.position.y = this.destination;
    this.floor = this.destination;
    this.destination = null;
    const arrival = this.landings[this.floor === 0 ? 0 : 1];
    this.setLandingOpen(arrival, true);
    const resolve = this.resolveRide;
    this.resolveRide = null;
    resolve?.(this.floor);
  }

  private setLandingOpen(landing: Landing, open: boolean): void {
    landing.target = open ? 1 : 0;
    if (landing === this.landings[this.floor === 0 ? 0 : 1]) this.carDoorTarget = landing.target;
  }
}
