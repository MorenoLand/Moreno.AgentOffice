import * as THREE from "three";
import { surfaceMaterial } from "./materials";
import type { OfficeModels } from "./models";

export interface LoftGeometry {
  colliders: THREE.Box3[];
  walkSurfaces: { minX: number; maxX: number; minZ: number; maxZ: number; height: number; slopeX?: number }[];
  light: THREE.SpotLight;
  bulb: THREE.Mesh;
}

export function buildLoft(scene: THREE.Scene, models: OfficeModels): LoftGeometry {
  const colliders: THREE.Box3[] = [];
  const walkSurfaces: LoftGeometry["walkSurfaces"] = [];
  const solid = surfaceMaterial(0xe6ddcf, 0.82);
  const metal = surfaceMaterial(0xa9a08f, 0.34, 0.6);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xc8e1e5, roughness: 0.07, metalness: 0, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.08 });
  const addBox = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, collision = false) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (collision) colliders.push(new THREE.Box3().setFromObject(mesh));
    return mesh;
  };
  const minX = 7.8;
  const maxX = 14.65;
  const minZ = 5.9;
  const maxZ = 10.25;
  const floorY = 3;
  const floorThickness = 0.24;
  const floorBottom = floorY - floorThickness;
  const stairStartX = 2.4;
  const stairRun = 0.27;
  const stairRise = 0.15;
  const stairZ = 9.45;
  const stairWidth = 1.12;
  const stairCount = 21;
  const topX = stairStartX + stairCount * stairRun;
  const openingStartX = Math.max(minX, topX - 0.42), openingEndX = Math.min(maxX, topX + 0.42);
  const openingMinZ = Math.max(minZ, stairZ - stairWidth / 2 - 0.18), openingMaxZ = Math.min(maxZ, stairZ + stairWidth / 2 + 0.18);
  const floorPart = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 <= 0.02 || z1 - z0 <= 0.02) return;
    const part = addBox(x1 - x0, floorThickness, z1 - z0, solid, (x0 + x1) / 2, floorY - floorThickness / 2, (z0 + z1) / 2, true);
    part.receiveShadow = true;
    walkSurfaces.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, height: floorY });
  };
  floorPart(minX, openingStartX, minZ, maxZ);
  floorPart(openingEndX, maxX, minZ, maxZ);
  floorPart(openingStartX, openingEndX, minZ, openingMinZ);
  floorPart(openingStartX, openingEndX, openingMaxZ, maxZ);
  for (const [x, z] of [[minX + 0.14, minZ + 0.14], [maxX - 0.14, minZ + 0.14], [minX + 0.14, maxZ - 0.14], [maxX - 0.14, maxZ - 0.14]]) addBox(0.2, floorBottom, 0.2, metal, x, floorBottom / 2, z, true);
  const railY = floorY + 1.25;
  const railH = 2.4;
  const glassWall = (w: number, h: number, d: number, x: number, z: number) => addBox(w, h, d, glass, x, railY, z, true);
  glassWall(maxX - minX, railH, 0.07, (minX + maxX) / 2, minZ);
  glassWall(0.07, railH, 2.5, minX, minZ + 1.25);
  addBox(maxX - minX, 0.1, 0.08, metal, (minX + maxX) / 2, floorY + 0.06, minZ + 0.12);

  for (let i = 0; i < stairCount; i++) {
    const top = i * stairRise;
    const x0 = stairStartX + i * stairRun;
    const step = addBox(stairRun + 0.04, stairRise, stairWidth, solid, x0 + stairRun / 2, top - stairRise / 2, stairZ);
    step.receiveShadow = true;
    walkSurfaces.push({ minX: x0 - 0.02, maxX: x0 + stairRun + 0.02, minZ: stairZ - stairWidth / 2, maxZ: stairZ + stairWidth / 2, height: top });
  }
  addBox(1.2, 0.2, openingMaxZ - openingMinZ, solid, topX + 0.6, floorY - 0.1, stairZ);
  walkSurfaces.push({ minX: topX, maxX: topX + 1.2, minZ: openingMinZ, maxZ: openingMaxZ, height: floorY });

  const sofa = models.create("lounge", "sofa", { width: 2.4, height: 1.25, depth: 0.75 }, { Sofa: 0x9c8bb7 });
  sofa.position.set(12.8, floorY, 6.85); scene.add(sofa);
  colliders.push(new THREE.Box3(new THREE.Vector3(11.6, floorY + 0.045, 6.475), new THREE.Vector3(14, floorY + 0.595, 7.225)));
  for (const [x, color, angle] of [[12.25, 0xe7b5c6, -0.13], [13.25, 0x9fcfc0, 0.1]]) {
    const pillow = models.create("lounge", "pillow", { width: 0.43, height: 0.42, depth: 0.16 }, { Cloth: color });
    pillow.position.set(x, floorY + 0.61, 6.8); pillow.rotation.z = angle; scene.add(pillow);
  }
  const table = models.create("lounge", "coffee_table", { width: 1.22, height: 0.405, depth: 0.72 });
  table.position.set(13.35, floorY, 8.25); scene.add(table);
  colliders.push(new THREE.Box3(new THREE.Vector3(12.775, floorY, 7.925), new THREE.Vector3(13.925, floorY + 0.34, 8.575)));
  const book = models.create("desk_props", "books_stack", { width: 0.36, height: 0.07, depth: 0.24 }, { CoverBlue: 0x7e9eab, Pages: 0xf5efdd }); book.position.set(13.16, floorY + 0.405, 8.23); scene.add(book);
  const mug = models.create("desk_props", "mug", { width: 0.19, height: 0.12, depth: 0.15 }, { Mug: 0xf2e7d1 }); mug.position.set(13.62, floorY + 0.405, 8.3); scene.add(mug);
  const plant = models.create("plants", "ficus", { width: 0.96, height: 1.3, depth: 0.86 });
  plant.position.set(8.65, floorY, 6.85); scene.add(plant);
  colliders.push(new THREE.Box3(new THREE.Vector3(8.44, floorY, 6.64), new THREE.Vector3(8.86, floorY + 0.48, 7.06)));
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshStandardMaterial({ color: 0xf5f1e8, emissive: 0xfff1ca, emissiveIntensity: 1, roughness: 0.35 }));
  bulb.position.set(11.4, 6.1, 7.8);
  const shade = new THREE.Mesh(new THREE.LatheGeometry([[0.34, -0.1], [0.32, -0.075], [0.275, -0.04], [0.21, 0], [0.13, 0.045], [0.065, 0.085], [0.04, 0.1]].map(([r, y]) => new THREE.Vector2(r, y)), 40), new THREE.MeshStandardMaterial({ color: 0xe8c87a, roughness: 0.38, metalness: 0.48, side: THREE.DoubleSide })); shade.position.set(11.4, 6.24, 7.8); shade.castShadow = true; scene.add(shade);
  const light = new THREE.SpotLight(0xffe5b2, 3, 7, 1.05, 0.7, 2);
  light.userData.onIntensity = 3; light.castShadow = true; light.shadow.mapSize.set(512, 512); light.shadow.normalBias = 0.018;
  light.position.copy(bulb.position);
  light.target.position.set(11.4, floorY, 7.8); scene.add(bulb, light, light.target);
  return { colliders, walkSurfaces, light, bulb };
}
