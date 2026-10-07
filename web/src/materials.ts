import * as THREE from "three";
const materials = new Map<string, THREE.MeshStandardMaterial>();
export function surfaceMaterial(color: number, roughness = 0.76, metalness = 0): THREE.MeshStandardMaterial {
  const key = `${color}:${roughness}:${metalness}`;
  let material = materials.get(key);
  if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness, metalness }); materials.set(key, material); }
  return material;
}
