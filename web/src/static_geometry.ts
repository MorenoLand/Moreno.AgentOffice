import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
export function mergeStaticMeshes(group: THREE.Group): void {
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert(), batches = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; geometries: THREE.BufferGeometry[] }>(), meshes: THREE.Mesh[] = [];
  group.traverse((object) => { if (object instanceof THREE.Mesh && !(object instanceof THREE.InstancedMesh) && !(object instanceof THREE.SkinnedMesh) && !Array.isArray(object.material)) meshes.push(object); });
  for (const mesh of meshes) { const material = mesh.material as THREE.Material, geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone(), key = `${material.uuid}:${mesh.castShadow}:${mesh.receiveShadow}:${Object.keys(geometry.attributes).sort().join(",")}`; geometry.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld)); geometry.clearGroups(); let batch = batches.get(key); if (!batch) { batch = { material, cast: mesh.castShadow, receive: mesh.receiveShadow, geometries: [] }; batches.set(key, batch); } batch.geometries.push(geometry); }
  if (!meshes.length) return;
  group.clear();
  for (const batch of batches.values()) { const geometry = mergeGeometries(batch.geometries, false); if (!geometry) throw new Error("Static geometry attributes do not match"); geometry.computeBoundingSphere(); geometry.computeBoundingBox(); const mesh = new THREE.Mesh(geometry, batch.material); mesh.castShadow = batch.cast; mesh.receiveShadow = batch.receive; group.add(mesh); for (const source of batch.geometries) source.dispose(); }
}
