import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ELEVATOR_LAYOUT } from "./elevator";
import { buildStreetTrees } from "./outdoor";
import { animateVehicle, updateVehicleBounds, vehicleOverlaps, type DriveCar, type VehicleKind } from "./driving";
import { mergeStaticMeshes } from "./static_geometry";

const STREET_Y = -3.6;
const EXIT_Z = 6.5;
export const EXIT_DOOR_OPENING_WIDTH = 1.4;
const EXIT_DOOR_WIDTH = EXIT_DOOR_OPENING_WIDTH - 0.12;
const EXIT_DOOR_HEIGHT = 2.32;
const LANDING_WIDTH = 4.4;
const LANDING_Z0 = 5.5;
const LANDING_Z1 = 7.5;
const STAIR_RUN = 0.3;
const STAIR_RISE = 0.12;
const STAIR_COUNT = 31;
const ROAD_Z0 = 21.5 - 3.2;
const ROAD_Z1 = 21.5 + 3.2;

export interface BuildingExterior {
  colliders: THREE.Box3[];
  walkHeightAt: (x: number, z: number) => number | undefined;
  exitDoorPosition: { x: number; z: number };
  setExitDoor: (open: boolean) => void;
  updateExitDoor: (dt: number) => void;
  updateTraffic: (dt: number) => void;
}

function material(color: number, roughness = 0.78, metalness = 0): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color, roughness, metalness }); }

export function buildExterior(scene: THREE.Scene, width: number, depth: number): BuildingExterior {
  const colliders: THREE.Box3[] = [];
  const floorX = width / 2;
  const floorZ = depth / 2;
  const westX = -floorX;
  const landingX = westX - LANDING_WIDTH / 2;
  const stairX = westX - 3;
  const stairBottomZ = LANDING_Z1 + STAIR_RUN * STAIR_COUNT;
  const architecture = new THREE.Group(), architectureMaterials = new Map<string, THREE.MeshStandardMaterial>(); architecture.name = "building-static-architecture"; scene.add(architecture);
  const architectureMaterial = (color: number, roughness = 0.78) => { const key = `${color}:${roughness}`; let cached = architectureMaterials.get(key); if (!cached) { cached = material(color, roughness); architectureMaterials.set(key, cached); } return cached; };
  const addBox = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, collision = false) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), architectureMaterial(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    architecture.add(mesh);
    if (collision) colliders.push(new THREE.Box3().setFromObject(mesh).expandByScalar(0.05));
    return mesh;
  };
  const ground = (w: number, d: number, x: number, y: number, z: number, color: number) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), architectureMaterial(color, 0.92));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    architecture.add(mesh);
  };
  ground(width + 4, depth + 4, 0, STREET_Y - 0.015, 0, 0xe1ddcf);
  const holeMinX = ELEVATOR_LAYOUT.x - ELEVATOR_LAYOUT.width / 2, holeMaxX = ELEVATOR_LAYOUT.x + ELEVATOR_LAYOUT.width / 2, holeMinZ = ELEVATOR_LAYOUT.z - ELEVATOR_LAYOUT.depth / 2, holeMaxZ = ELEVATOR_LAYOUT.z + ELEVATOR_LAYOUT.depth / 2;
  const slabMinX = -floorX - 1.5, slabMaxX = floorX + 1.5, slabMinZ = -floorZ - 1.5, slabMaxZ = floorZ + 1.5;
  addBox(holeMinX - slabMinX, 0.24, depth + 3, 0xc8c7bc, (slabMinX + holeMinX) / 2, -0.17, 0);
  addBox(slabMaxX - holeMaxX, 0.24, depth + 3, 0xc8c7bc, (holeMaxX + slabMaxX) / 2, -0.17, 0);
  addBox(holeMaxX - holeMinX, 0.24, holeMinZ - slabMinZ, 0xc8c7bc, ELEVATOR_LAYOUT.x, -0.17, (slabMinZ + holeMinZ) / 2);
  addBox(holeMaxX - holeMinX, 0.24, slabMaxZ - holeMaxZ, 0xc8c7bc, ELEVATOR_LAYOUT.x, -0.17, (holeMaxZ + slabMaxZ) / 2);
  for (const x of [-floorX + 1, 0, floorX - 1]) for (const z of [-floorZ + 1, 0, floorZ - 1]) addBox(0.34, 3.22, 0.34, 0xb8bec5, x, -1.95, z, true);
  for (const z of [-floorZ - 1.2, floorZ + 1.2]) addBox(width + 2.4, 0.28, 0.25, 0x8e949c, 0, -0.35, z);
  addBox(0.25, 3.25, depth + 2.4, 0x8e949c, floorX + 1.1, -1.95, 0);
  addBox(width + 1.8, 2.55, 0.18, 0x545b63, 0, STREET_Y + 1.55, -floorZ - 1.28, true);
  for (const x of [-floorX - 0.5, floorX + 0.5]) addBox(0.22, 2.4, 0.22, 0x8e949c, x, STREET_Y + 1.3, -floorZ - 1.28);
  const stairConnector = addBox(8, 0.05, ROAD_Z0 - stairBottomZ, 0xc9c9bf, stairX, STREET_Y, (ROAD_Z0 + stairBottomZ) / 2);
  colliders.push(new THREE.Box3().setFromObject(stairConnector));

  for (let x = -floorX + 2.8; x <= floorX - 2.8; x += 4.8) {
    addBox(0.08, 0.025, depth - 1.5, 0xd9c68e, x, STREET_Y + 0.025, 0);
    addBox(0.18, 3.25, 0.18, 0xf2d995, x, -1.95, -floorZ + 1.1);
    addBox(0.18, 3.25, 0.18, 0xf2d995, x, -1.95, floorZ - 1.1);
  }
  const driveCars: DriveCar[] = [], trafficModels: DriveCar[] = [];
  scene.userData.driveCars = driveCars; scene.userData.trafficCars = trafficModels;
  const car = (x: number, z: number, color: number, colliding = true, kind: VehicleKind = "sedan"): THREE.Group => {
    const root = new THREE.Group();
    root.position.set(x, STREET_Y, z);
    const carMaterials = new Map<string, THREE.MeshStandardMaterial>(), carMaterial = (color: number, roughness = 0.78, metalness = 0) => { const key = `${color}:${roughness}:${metalness}`; let cached = carMaterials.get(key); if (!cached) { cached = material(color, roughness, metalness); carMaterials.set(key, cached); } return cached; };
    const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.29, metalness: 0.32, clearcoat: 0.65, clearcoatRoughness: 0.22 }), trim = carMaterial(0x252b2e, 0.62), rubber = carMaterial(0x24272a, 0.96), chrome = carMaterial(0xbfc8cc, 0.27, 0.78);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x426779, roughness: 0.13, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.09, side: THREE.DoubleSide });
    const rounded = (width: number, height: number, length: number, mat: THREE.Material, px: number, py: number, pz: number, radius = 0.04) => { const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, length, Math.min(width, height, length) < 0.04 ? 1 : 2, radius), mat); mesh.position.set(px, py, pz); mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); return mesh; };
    const bar = (a: [number, number, number], b: [number, number, number], mat: THREE.Material, radius = 0.013) => { const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), direction = end.clone().sub(start), mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 8), mat); mesh.position.copy(start.add(end).multiplyScalar(0.5)); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()); root.add(mesh); };
    const addGlass = (points: [number, number, number][]) => { const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3)); geometry.setIndex([0, 1, 2, 0, 2, 3]); geometry.computeVertexNormals(); root.add(new THREE.Mesh(geometry, glass)); for (let i = 0; i < points.length; i++) bar(points[i], points[(i + 1) % points.length], trim); };
    const bodyShape = new THREE.Shape();
    bodyShape.moveTo(-1.76, 0.26); bodyShape.lineTo(-1.79, 0.54); bodyShape.quadraticCurveTo(-1.7, 0.76, -1.39, 0.79); bodyShape.lineTo(-0.94, 0.79); bodyShape.lineTo(0.83, 0.81); bodyShape.lineTo(1.3, 0.77); bodyShape.quadraticCurveTo(1.72, 0.73, 1.77, 0.55); bodyShape.lineTo(1.76, 0.26); bodyShape.lineTo(1.49, 0.26); bodyShape.lineTo(1.49, 0.34); bodyShape.absarc(1.08, 0.34, 0.41, 0, Math.PI, false); bodyShape.lineTo(0.67, 0.26); bodyShape.lineTo(-0.67, 0.26); bodyShape.lineTo(-0.67, 0.34); bodyShape.absarc(-1.08, 0.34, 0.41, 0, Math.PI, false); bodyShape.lineTo(-1.49, 0.26); bodyShape.closePath();
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(bodyShape, { depth: 1.72, curveSegments: 18, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.027, bevelThickness: 0.027 }), paint);
    body.rotation.y = -Math.PI / 2; body.position.x = 0.86; body.castShadow = body.receiveShadow = true; root.add(body);
    rounded(1.51, 0.035, 0.73, paint, 0, 0.792, 1.16, 0.016);
    rounded(1.49, 0.035, 0.49, paint, 0, 0.797, -1.32, 0.016);
    const cabinShape = new THREE.Shape();
    const roofY = kind === "coupe" ? 1.2 : kind === "wagon" || kind === "pickup" ? 1.5 : 1.45, rearBase = kind === "wagon" ? -1.57 : kind === "pickup" ? -0.66 : -0.94, rearRoof = kind === "wagon" ? -1.24 : kind === "pickup" ? -0.33 : -0.46, frontRoof = kind === "coupe" ? 0.1 : 0.26;
    cabinShape.moveTo(rearBase, 0.78); cabinShape.lineTo(0.83, 0.78); cabinShape.lineTo(frontRoof, roofY); cabinShape.lineTo(rearRoof, roofY); cabinShape.closePath();
    const cabin = new THREE.Mesh(new THREE.ExtrudeGeometry(cabinShape, { depth: 1.32, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.025, bevelThickness: 0.025 }), paint);
    cabin.rotation.y = -Math.PI / 2; cabin.position.x = 0.66; cabin.castShadow = cabin.receiveShadow = true; root.add(cabin);
    const paneTop = roofY - 0.095, frontZ = (y: number) => 0.83 + (frontRoof - 0.83) * (y - 0.78) / (roofY - 0.78) + 0.035, rearZ = (y: number) => rearBase + (rearRoof - rearBase) * (y - 0.78) / (roofY - 0.78) - 0.035;
    addGlass([[-0.575, paneTop, frontZ(paneTop)], [0.575, paneTop, frontZ(paneTop)], [0.575, 0.885, frontZ(0.885)], [-0.575, 0.885, frontZ(0.885)]]);
    addGlass([[-0.575, paneTop, rearZ(paneTop)], [0.575, paneTop, rearZ(paneTop)], [0.575, 0.885, rearZ(0.885)], [-0.575, 0.885, rearZ(0.885)]]);
    for (const side of [-1, 1]) {
      const sx = side * 0.688;
      addGlass([[sx, 0.89, -0.04], [sx, 0.89, frontZ(0.89) - 0.08], [sx, paneTop, frontZ(paneTop) - 0.075], [sx, paneTop, -0.04]]);
      addGlass([[sx, 0.89, -0.12], [sx, 0.89, rearZ(0.89) + 0.08], [sx, paneTop, rearZ(paneTop) + 0.075], [sx, paneTop, -0.12]]);
      if (kind === "wagon") bar([side * 0.64, roofY + 0.031, -1.17], [side * 0.64, roofY + 0.031, 0.14], chrome, 0.014);
      rounded(0.015, 0.3, 0.015, trim, side * 0.892, 0.53, -0.08, 0.007);
      rounded(0.018, 0.055, 1.27, trim, side * 0.89, 0.31, 0, 0.008);
      rounded(0.03, 0.035, 0.14, chrome, side * 0.905, 0.69, -0.24, 0.015);
      rounded(0.03, 0.035, 0.14, chrome, side * 0.905, 0.69, 0.41, 0.015);
      bar([side * 0.71, 0.965, 0.62], [side * 0.89, 0.965, 0.62], trim, 0.021);
      rounded(0.18, 0.105, 0.16, paint, side * 0.95, 0.985, 0.64, 0.038);
      rounded(0.13, 0.067, 0.018, glass, side * 0.95, 0.985, 0.552, 0.024);
    }
    rounded(0.7, 0.14, 0.035, trim, 0, 0.5, 1.8, 0.016);
    for (const y of [0.462, 0.505, 0.548]) rounded(0.6, 0.012, 0.018, chrome, 0, y, 1.827, 0.005);
    rounded(0.29, 0.087, 0.019, carMaterial(0xe8e4d7, 0.7), 0, 0.34, 1.865, 0.008);
    rounded(0.29, 0.087, 0.019, carMaterial(0xe8e4d7, 0.7), 0, 0.47, -1.827, 0.008);
    for (const side of [-1, 1]) {
      const headlamp = carMaterial(0xf8ecd1, 0.16, 0.12), tailLamp = carMaterial(0xb72b27, 0.23); headlamp.emissive.setHex(0xffedbf); headlamp.emissiveIntensity = 0.2; tailLamp.emissive.setHex(0xa52018); tailLamp.emissiveIntensity = 0.15;
      rounded(0.34, 0.145, 0.055, trim, side * 0.62, 0.645, 1.749, 0.034);
      rounded(0.3, 0.11, 0.065, headlamp, side * 0.62, 0.645, 1.775, 0.027);
      rounded(0.3, 0.13, 0.07, tailLamp, side * 0.62, 0.64, -1.775, 0.03);
      rounded(0.07, 0.065, 0.045, carMaterial(0xe5a552, 0.25), side * 0.82, 0.61, 1.744, 0.02);
    }
    for (const end of [-1, 1]) { rounded(1.68, 0.12, 0.14, paint, 0, 0.31, end * 1.77, 0.04); rounded(1.54, 0.028, 0.08, trim, 0, 0.31, end * 1.833, 0.012); }
    if (kind === "coupe") { for (const side of [-1, 1]) rounded(0.04, 0.16, 0.045, trim, side * 0.59, 0.94, -1.46, 0.01); rounded(1.45, 0.05, 0.24, trim, 0, 1.04, -1.46, 0.02); }
    if (kind === "pickup") { rounded(1.38, 0.022, 0.89, trim, 0, 0.817, -1.16, 0.01); for (const side of [-1, 1]) rounded(0.11, 0.22, 1.06, paint, side * 0.75, 0.89, -1.23, 0.025); rounded(1.45, 0.22, 0.09, paint, 0, 0.89, -1.74, 0.025); }
    const bodyParts = new THREE.Group(); for (const part of root.children.slice()) bodyParts.add(part); root.add(bodyParts); mergeStaticMeshes(bodyParts);
    const wheels: DriveCar["wheels"] = [];
    for (const side of [-1, 1]) for (const end of [-1, 1]) {
      const start = root.children.length;
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 32), rubber);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 0.87, 0.34, end * 1.08);
      wheel.castShadow = true;
      root.add(wheel);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.025, 32), trim);
      hub.rotation.z = Math.PI / 2; hub.position.set(side * 0.991, 0.34, end * 1.08); root.add(hub);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.226, 0.018, 8, 32), chrome);
      rim.rotation.y = Math.PI / 2; rim.position.set(side * 1.013, 0.34, end * 1.08); root.add(rim);
      const sidewall = new THREE.Mesh(new THREE.TorusGeometry(0.298, 0.022, 8, 32), rubber); sidewall.rotation.y = Math.PI / 2; sidewall.position.set(side * 0.987, 0.34, end * 1.08); root.add(sidewall);
      for (let i = 0; i < 5; i++) { const angle = i * Math.PI * 2 / 5, spoke = rounded(0.027, 0.16, 0.045, chrome, side * 1.013, 0.34 + Math.cos(angle) * 0.12, end * 1.08 + Math.sin(angle) * 0.12, 0.013); spoke.rotation.x = angle; }
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.035, 20), chrome);
      cap.rotation.z = Math.PI / 2; cap.position.set(side * 1.025, 0.34, end * 1.08); root.add(cap);
      const pivot = new THREE.Group(), spin = new THREE.Group(), parts = root.children.slice(start); pivot.position.set(side * 0.87, 0.34, end * 1.08); pivot.add(spin); for (const part of parts) { part.position.sub(pivot.position); spin.add(part); } root.add(pivot); mergeStaticMeshes(spin); wheels.push({ pivot, spin, front: end > 0 });
    }
    scene.add(root);
    const collider = new THREE.Box3(), model: DriveCar = { id: colliding ? driveCars.length : -1, name: kind === "coupe" ? "Sport coupe" : kind === "wagon" ? "Estate wagon" : kind === "pickup" ? "Pickup truck" : "City sedan", kind, root, collider, wheels, wheelRadius: 0.34, wheelbase: 2.16, maxSpeed: kind === "coupe" ? 21 : kind === "pickup" ? 13 : kind === "wagon" ? 15 : 17 }; root.userData.vehicle = model; updateVehicleBounds(model);
    if (colliding) { colliders.push(collider); driveCars.push(model); } else trafficModels.push(model);
    return root;
  };
  car(-11, -3, 0x40a66b, true, "wagon");
  car(-4, 4, 0xd45d4e, true, "coupe");
  car(4, -3, 0x4286b5, true, "sedan");
  car(11, 4, 0xe2ad43, true, "pickup");

  const trafficCars: { root: THREE.Group; direction: number; speed: number }[] = [];
  const pedestrians: { root: THREE.Group; leftLeg: THREE.Group; rightLeg: THREE.Group; leftArm: THREE.Group; rightArm: THREE.Group; direction: number; endZ: number; speed: number; phase: number }[] = [];
  let trafficMode: "cars" | "clearing" | "pedestrians" = "cars";
  let trafficTimer = 20 + Math.random() * 14;
  let spawnTimer = 1 + Math.random() * 2;
  let pedestrianWaves = 0;
  const disposeActor = (root: THREE.Group) => { const modelIndex = trafficModels.findIndex((model) => model.root === root); if (modelIndex >= 0) trafficModels.splice(modelIndex, 1); const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(); root.traverse((object) => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const item of Array.isArray(object.material) ? object.material : [object.material]) materials.add(item); } }); geometries.forEach((geometry) => geometry.dispose()); materials.forEach((item) => item.dispose()); scene.remove(root); };
  const makePedestrian = (x: number, z: number, direction: number, endZ: number) => {
    const root = new THREE.Group();
    const shirt = material([0x86b5c0, 0xc88777, 0x90ad7a, 0xa59abd, 0xd1ad72][Math.floor(Math.random() * 5)]);
    const pants = material([0x5b6574, 0x766966, 0x65767a][Math.floor(Math.random() * 3)]);
    const skin = material([0xc9916d, 0x9d684d, 0xe0b28b, 0x704a3b][Math.floor(Math.random() * 4)]);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.22, 4, 10), shirt);
    torso.scale.z = 0.62;
    torso.position.y = 1.08;
    torso.castShadow = true;
    root.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), skin);
    head.position.y = 1.48;
    head.castShadow = true;
    root.add(head);
    const limb = (x: number, y: number, length: number, radius: number, tone: THREE.MeshStandardMaterial) => { const pivot = new THREE.Group(); pivot.position.set(x, y, 0); const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0.04, length - radius * 2), 4, 8), tone); mesh.position.y = -length / 2; mesh.castShadow = true; pivot.add(mesh); root.add(pivot); return pivot; };
    const leftArm = limb(-0.22, 1.3, 0.52, 0.07, shirt);
    const rightArm = limb(0.22, 1.3, 0.52, 0.07, shirt);
    const leftLeg = limb(-0.1, 0.8, 0.76, 0.075, pants);
    const rightLeg = limb(0.1, 0.8, 0.76, 0.075, pants);
    const hair = material([0x64493e, 0x936b48, 0xd2b15e, 0x453d3d][Math.floor(Math.random() * 4)]);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.48), hair);
    cap.position.set(0, 1.51, -0.005); root.add(cap);
    for (const side of [-1, 1]) {
      const button = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), material(0xe6c98d));
      button.position.set(0, 1.14 - (side + 1) * 0.035, 0.112); root.add(button);
    }
    root.position.set(x, STREET_Y, z);
    root.rotation.y = direction > 0 ? 0 : Math.PI;
    scene.add(root);
    return { root, leftLeg, rightLeg, leftArm, rightArm, direction, endZ, speed: 0.88 + Math.random() * 0.38, phase: Math.random() * Math.PI * 2 };
  };
  const spawnPedestrianWave = () => {
    const direction = Math.random() < 0.5 ? 1 : -1;
    const startZ = direction > 0 ? ROAD_Z0 - 0.7 : ROAD_Z1 + 0.7;
    const endZ = direction > 0 ? ROAD_Z1 + 0.7 : ROAD_Z0 - 0.7;
    const count = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) pedestrians.push(makePedestrian((i - (count - 1) / 2) * 0.62 + (Math.random() - 0.5) * 0.16, startZ - direction * i * 0.72, direction, endZ));
  };
  const updateTraffic = (dt: number) => {
    if (trafficMode === "cars") {
      trafficTimer -= dt;
      spawnTimer -= dt;
      if (spawnTimer <= 0 && trafficCars.length < 4) {
        const direction = Math.random() < 0.5 ? 1 : -1;
        const roadZ = Math.random() < 0.65 ? (ROAD_Z0 + ROAD_Z1) / 2 : -21.5;
        const root = car(direction > 0 ? -76 : 76, roadZ + (direction > 0 ? -1.05 : 1.05), [0x315c70, 0x914c3f, 0xb6944e, 0xd1d4d1, 0x48505a][Math.floor(Math.random() * 5)], false, (["sedan", "coupe", "wagon", "pickup"] as const)[Math.floor(Math.random() * 4)]);
        root.rotation.y = direction > 0 ? Math.PI / 2 : -Math.PI / 2;
        updateVehicleBounds(root.userData.vehicle as DriveCar);
        trafficCars.push({ root, direction, speed: 5.2 + Math.random() * 2.2 });
        spawnTimer = 4.5 + Math.random() * 4.5;
      }
      if (trafficTimer <= 0) trafficMode = "clearing";
    }
    for (let i = trafficCars.length - 1; i >= 0; i--) {
      const vehicle = trafficCars[i];
      const model = vehicle.root.userData.vehicle as DriveCar, nextX = vehicle.root.position.x + vehicle.direction * vehicle.speed * dt, pose = { x: nextX, z: vehicle.root.position.z, yaw: vehicle.root.rotation.y }, clear = [...driveCars, ...trafficModels].every((other) => other === model || Math.abs(other.root.position.x - nextX) > 7 || !vehicleOverlaps(pose, other.collider));
      if (clear) { vehicle.root.position.x = nextX; animateVehicle(model, vehicle.speed * dt); updateVehicleBounds(model); }
      if (vehicle.root.position.x < -78 || vehicle.root.position.x > 78) { disposeActor(vehicle.root); trafficCars.splice(i, 1); }
    }
    for (let i = pedestrians.length - 1; i >= 0; i--) {
      const pedestrian = pedestrians[i];
      pedestrian.phase += dt * 7.5;
      pedestrian.root.position.z += pedestrian.direction * pedestrian.speed * dt;
      pedestrian.root.position.y = STREET_Y + Math.max(0, Math.sin(pedestrian.phase * 2)) * 0.025;
      pedestrian.leftLeg.rotation.x = Math.sin(pedestrian.phase) * 0.42;
      pedestrian.rightLeg.rotation.x = -pedestrian.leftLeg.rotation.x;
      pedestrian.leftArm.rotation.x = -pedestrian.leftLeg.rotation.x * 0.7;
      pedestrian.rightArm.rotation.x = pedestrian.leftLeg.rotation.x * 0.7;
      if (pedestrian.direction > 0 ? pedestrian.root.position.z >= pedestrian.endZ : pedestrian.root.position.z <= pedestrian.endZ) { disposeActor(pedestrian.root); pedestrians.splice(i, 1); }
    }
    if (trafficMode === "clearing" && trafficCars.length === 0) { trafficMode = "pedestrians"; pedestrianWaves = 1 + Math.floor(Math.random() * 2); }
    if (trafficMode === "pedestrians" && pedestrians.length === 0) {
      if (pedestrianWaves > 0) { spawnPedestrianWave(); pedestrianWaves--; }
      else { trafficMode = "cars"; trafficTimer = 22 + Math.random() * 18; spawnTimer = 2 + Math.random() * 3; }
    }
  };

  const landing = addBox(LANDING_WIDTH, 0.18, LANDING_Z1 - LANDING_Z0, 0xb8bdc4, landingX, -0.09, EXIT_Z);
  landing.receiveShadow = true;
  colliders.push(new THREE.Box3().setFromObject(landing));
  for (let i = 0; i < STAIR_COUNT; i++) {
    const top = -i * STAIR_RISE;
    const tread = addBox(1.6, STAIR_RISE, STAIR_RUN, 0xc7cbd0, stairX, top - STAIR_RISE / 2, LANDING_Z1 + (i + 0.5) * STAIR_RUN);
    colliders.push(new THREE.Box3().setFromObject(tread));
  }
  const doorTop = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, EXIT_DOOR_OPENING_WIDTH + 0.16), material(0xb99b72));
  doorTop.position.set(westX - 0.05, 2.55, EXIT_Z);
  architecture.add(doorTop);
  const exitCanvas = document.createElement("canvas");
  exitCanvas.width = 256;
  exitCanvas.height = 80;
  const ctx = exitCanvas.getContext("2d")!;
  ctx.fillStyle = "#258b4c";
  ctx.fillRect(0, 0, 256, 80);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 52px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("EXIT", 128, 58);
  const exitTexture = new THREE.CanvasTexture(exitCanvas);
  exitTexture.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.28), new THREE.MeshBasicMaterial({ map: exitTexture, side: THREE.DoubleSide }));
  sign.rotation.y = Math.PI / 2;
  sign.position.set(westX + 0.04, 2.72, EXIT_Z);
  architecture.add(sign);
  const exitDoor = new THREE.Group();
  exitDoor.position.set(westX - 0.08, 0, EXIT_Z - EXIT_DOOR_WIDTH / 2);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.08, EXIT_DOOR_HEIGHT, EXIT_DOOR_WIDTH), material(0x765c43));
  leaf.position.set(0, EXIT_DOOR_HEIGHT / 2, EXIT_DOOR_WIDTH / 2);
  leaf.castShadow = true;
  exitDoor.add(leaf);
  const vision = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.46), new THREE.MeshBasicMaterial({ color: 0x91b5bb, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
  vision.rotation.y = Math.PI / 2;
  vision.position.set(-0.045, 1.53, EXIT_DOOR_WIDTH / 2 - 0.1);
  exitDoor.add(vision);
  const handle = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), material(0xd6b46d));
  handle.position.set(-0.075, 1.02, EXIT_DOOR_WIDTH - 0.16);
  exitDoor.add(handle);
  scene.add(exitDoor);
  const exitBounds = new THREE.Box3(new THREE.Vector3(westX - 0.3, 0, EXIT_Z - EXIT_DOOR_OPENING_WIDTH / 2), new THREE.Vector3(westX + 0.12, EXIT_DOOR_HEIGHT + 0.04, EXIT_Z + EXIT_DOOR_OPENING_WIDTH / 2));
  colliders.push(exitBounds);
  let exitDoorTarget = 0;
  const setExitDoor = (open: boolean) => {
    exitDoorTarget = open ? Math.PI / 2 : 0;
    if (open) { exitBounds.min.y = EXIT_DOOR_HEIGHT + 0.12; exitBounds.max.y = EXIT_DOOR_HEIGHT + 0.11; }
  };
  const updateExitDoor = (dt: number) => {
    exitDoor.rotation.y = THREE.MathUtils.damp(exitDoor.rotation.y, exitDoorTarget, 5, dt);
    if (exitDoorTarget === 0 && exitDoor.rotation.y < 0.025) { exitBounds.min.y = 0; exitBounds.max.y = EXIT_DOOR_HEIGHT + 0.04; }
  };

  buildStreetTrees(scene, [-20, -7, 6, 19].map((x): [number, number, number] => [x, ROAD_Z0 - 1.4, 0.8]), undefined, 4, 0.125);
  mergeStaticMeshes(architecture);

  const walkHeightAt = (x: number, z: number): number | undefined => {
    if (x >= landingX - LANDING_WIDTH / 2 - 0.35 && x <= landingX + LANDING_WIDTH / 2 + 0.35 && z >= LANDING_Z0 - 0.35 && z <= LANDING_Z1 + 0.35) return 0;
    if (x >= stairX - 1.15 && x <= stairX + 1.15 && z >= LANDING_Z1 && z <= stairBottomZ) return -Math.min(STAIR_COUNT - 1, Math.floor((z - LANDING_Z1) / STAIR_RUN)) * STAIR_RISE;
    if (x >= stairX - 4 && x <= stairX + 4 && z >= stairBottomZ && z <= ROAD_Z0) return STREET_Y + 0.025;
    if (x >= -74 && x <= 74 && z >= ROAD_Z0 && z <= ROAD_Z1) return STREET_Y + 0.025;
    if (x >= -floorX - 2 && x <= floorX + 2 && z >= -floorZ - 2 && z <= floorZ + 2) return STREET_Y;
    return undefined;
  };
  return { colliders, walkHeightAt, exitDoorPosition: { x: westX - 0.4, z: EXIT_Z }, setExitDoor, updateExitDoor, updateTraffic };
}
