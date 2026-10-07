import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
type OfficeAsset = "lounge" | "kitchen" | "plants" | "desk_props";
type ModelSize = { width?: number; height?: number; depth?: number };
const ASSETS: OfficeAsset[] = ["lounge", "kitchen", "plants", "desk_props"];
const COLORS: Record<OfficeAsset, Record<string, number>> = {
  lounge: { Wood: 0x9e714e, Frame: 0x35404a, Cloth: 0xcab69e, Sofa: 0x526e79, WoodDark: 0x594237 },
  kitchen: { Dark: 0x273034, Chrome: 0xb9c3c8, White: 0xe7ece9, Glow: 0xd95c47, Cabinet: 0x778f92, Wood: 0x9e714e, Fridge: 0xe0e6e2, Note: 0xe3ca88, Red: 0xbd6657, Memo: 0xa9c4cd },
  plants: { Bark: 0x6b4d35, LeafDark: 0x315a3e, Leaf: 0x4b8050, Pot: 0xa7684a, Soil: 0x392b22, Glaze: 0x7c9b9b },
  desk_props: { CoverBlue: 0x527386, Pages: 0xe9e0cf, CoverOrange: 0xb28351, CoverRed: 0xaa5a50, Mug: 0x9eb9b7, Coffee: 0x3f291c }
};
export class OfficeModels {
  constructor(private readonly assets: ReadonlyMap<OfficeAsset, THREE.Object3D>) {}
  create(asset: OfficeAsset, part: string, size: ModelSize, colors: Record<string, number> = {}): THREE.Group {
    const source = this.assets.get(asset)?.getObjectByName(part);
    if (!source) throw new Error(`${asset}.glb has no ${part}`);
    const model = source.clone(true), group = new THREE.Group(), materials = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model), dimensions = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    if (bounds.isEmpty() || dimensions.x <= 0 || dimensions.y <= 0 || dimensions.z <= 0) throw new Error(`${asset}.glb ${part} has invalid bounds`);
    for (const value of Object.values(size)) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${asset}.glb ${part} has invalid target size`);
    const uniform = size.height !== undefined ? size.height / dimensions.y : size.width !== undefined ? size.width / dimensions.x : size.depth !== undefined ? size.depth / dimensions.z : 1;
    model.position.set(-center.x, -bounds.min.y, -center.z);
    group.scale.set(size.width !== undefined ? size.width / dimensions.x : uniform, size.height !== undefined ? size.height / dimensions.y : uniform, size.depth !== undefined ? size.depth / dimensions.z : uniform);
    const paint = (original: THREE.Material): THREE.MeshStandardMaterial => {
      const existing = materials.get(original);
      if (existing) return existing;
      const name = original.name, color = colors[name] ?? COLORS[asset][name];
      if (color === undefined) throw new Error(`${asset}.glb ${part} has unknown material ${name}`);
      const chrome = name === "Chrome", glazed = name === "Glaze" || name === "Mug", fabric = name === "Cloth" || name === "Sofa";
      const material = new THREE.MeshStandardMaterial({ name, color, roughness: chrome ? 0.24 : glazed ? 0.23 : fabric ? 0.96 : name === "Soil" ? 1 : name === "Fridge" || name === "White" ? 0.34 : 0.76, metalness: chrome ? 0.75 : name === "Frame" ? 0.35 : 0, side: original.side, transparent: original.transparent, opacity: original.opacity });
      if (original instanceof THREE.MeshStandardMaterial) { material.emissive.copy(original.emissive); material.emissiveIntensity = original.emissiveIntensity; }
      if (name === "Glow") { material.emissive.set(color); material.emissiveIntensity = 0.65; }
      materials.set(original, material);
      return material;
    };
    model.traverse((object) => { const mesh = object as THREE.Mesh; if (!mesh.isMesh) return; mesh.material = Array.isArray(mesh.material) ? mesh.material.map(paint) : paint(mesh.material); mesh.castShadow = true; mesh.receiveShadow = true; });
    group.name = `${asset}/${part}`;
    group.add(model);
    return group;
  }
}
let loading: Promise<OfficeModels> | undefined;
export function loadOfficeModels(): Promise<OfficeModels> {
  if (!loading) { const loader = new GLTFLoader(); loading = Promise.all(ASSETS.map(async (asset) => [asset, (await loader.loadAsync(`${import.meta.env.BASE_URL}models/${asset}.glb`)).scene] as const)).then((assets) => new OfficeModels(new Map<OfficeAsset, THREE.Object3D>(assets))); }
  return loading;
}
