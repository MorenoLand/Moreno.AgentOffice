import * as THREE from "three";
import { surfaceMaterial } from "./materials";
import { mergeStaticMeshes } from "./static_geometry";

const STREET_Y = -3.6;
const colors = [0xb9ccd0, 0xd9c5b0, 0xbccdb5, 0xd2bfd4, 0xc8d4df, 0xd6c8aa];
interface TreeBatch { crowns: THREE.InstancedMesh; leaves: THREE.InstancedMesh; centres: [number, number, number][]; phase: number }

export function buildOutdoor(scene: THREE.Scene): THREE.Box3[] {
  const colliders: THREE.Box3[] = [];
  const lamps: { bulb: THREE.Mesh; glow: THREE.PointLight }[] = [];
  const windows: THREE.Mesh[] = [];
  const architecture = new THREE.Group(); architecture.name = "outdoor-static-architecture"; scene.add(architecture);
  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), surfaceMaterial(0xa5c68d, 0.98).clone());
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.y = STREET_Y - 0.08;
  lawn.receiveShadow = true;
  scene.add(lawn);
  scene.userData.outdoorLawn = lawn;
  const wallMats = colors.map((color) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.16), roughness: 0.86, metalness: 0.025 }));
  const windowMats = [0xb4dce7, 0xd5e7e8, 0xf0dba9, 0xc3d7ea].map((color) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.1, roughness: 0.38, metalness: 0.08, transparent: true, opacity: 0.8 }));
  const facadeTrim = new THREE.MeshStandardMaterial({ color: 0xd0c7b2, roughness: 0.82, metalness: 0.04 });
  const windowFrame = new THREE.MeshStandardMaterial({ color: 0x78898b, roughness: 0.7, metalness: 0.1 });
  const roofMetal = new THREE.MeshStandardMaterial({ color: 0x96a4a3, roughness: 0.72, metalness: 0.18 });
  const paneMaterials = new Map<string, THREE.MeshStandardMaterial>(), theaterBulbs = [new THREE.MeshBasicMaterial({ color: 0xfff2c1 }), new THREE.MeshBasicMaterial({ color: 0xffcc75 })];
  const addBox = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, collision = false) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    architecture.add(mesh);
    if (collision) colliders.push(new THREE.Box3().setFromObject(mesh).expandByScalar(0.04));
    return mesh;
  };
  const block = (x: number, z: number, w: number, d: number, h: number, color: number, facing: "north" | "south" | "east" | "west") => {
    const building = addBox(w, h, d, wallMats[colors.indexOf(color)] ?? wallMats[0], x, STREET_Y + h / 2, z, true);
    addBox(w + 0.45, 0.36, d + 0.45, facadeTrim, x, STREET_Y + h + 0.18, z);
    const floors = Math.floor(h / 2.8), across = Math.max(2, Math.floor(w / 2.5)), sideFacing = facing === "east" || facing === "west", faceRotation = facing === "east" ? -Math.PI / 2 : facing === "west" ? Math.PI / 2 : facing === "south" ? Math.PI : 0, paneWidth = (sideFacing ? d : w) / across * 0.56;
    const verticalFrames = new THREE.InstancedMesh(new THREE.BoxGeometry(0.065, 1.56, 0.08), windowFrame, floors * across * 2);
    const horizontalFrames = new THREE.InstancedMesh(new THREE.BoxGeometry(paneWidth + 0.14, 0.07, 0.08), facadeTrim, floors * across * 2);
    const mullions = new THREE.InstancedMesh(new THREE.BoxGeometry(0.045, 1.22, 0.09), windowFrame, floors * across), frameTransform = new THREE.Object3D();
    for (let floor = 0; floor < floors; floor++) for (let column = 0; column < across; column++) {
      const wx = x - w / 2 + (column + 0.5) * w / across;
      const wy = STREET_Y + 1.25 + floor * 2.8;
      const wz = facing === "north" ? z + d / 2 + 0.07 : facing === "south" ? z - d / 2 - 0.07 : z - d / 2 + (column + 0.5) * d / across;
      const dayIndex = (floor + column) % windowMats.length, lit = (floor + column) % 3 === 0, paneKey = `${dayIndex}:${lit}`;
      let paneMat = paneMaterials.get(paneKey); if (!paneMat) { paneMat = windowMats[dayIndex].clone(); paneMaterials.set(paneKey, paneMat); }
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(paneWidth, 1.38), paneMat);
      pane.userData.dayColor = paneMat.color.getHex();
      pane.userData.nightColor = (floor + column) % 3 === 0 ? 0xf1c984 : 0x334351;
      pane.userData.dayEmissive = 0x263b49;
      pane.userData.nightEmissive = (floor + column) % 3 === 0 ? 0xffbd63 : 0x17212a;
      const facadeX = facing === "east" ? x - w / 2 - 0.07 : facing === "west" ? x + w / 2 + 0.07 : wx;
      pane.position.set(facadeX + (facing === "east" ? -0.04 : facing === "west" ? 0.04 : 0), wy, wz + (facing === "north" ? 0.04 : facing === "south" ? -0.04 : 0));
      pane.rotation.y = facing === "east" ? -Math.PI / 2 : facing === "west" ? Math.PI / 2 : facing === "south" ? Math.PI : 0;
      architecture.add(pane);
      windows.push(pane);
      for (const side of [-1, 1]) {
        frameTransform.position.set(facadeX + (sideFacing ? 0 : side * (paneWidth / 2 + 0.035)), wy, wz + (sideFacing ? side * (paneWidth / 2 + 0.035) : 0)); frameTransform.rotation.y = faceRotation;
        frameTransform.updateMatrix(); verticalFrames.setMatrixAt((floor * across + column) * 2 + (side > 0 ? 1 : 0), frameTransform.matrix);
        frameTransform.position.set(facadeX, wy + side * 0.77, wz); frameTransform.rotation.y = faceRotation; frameTransform.updateMatrix();
        horizontalFrames.setMatrixAt((floor * across + column) * 2 + (side > 0 ? 1 : 0), frameTransform.matrix);
      }
      frameTransform.position.set(facadeX, wy, wz); frameTransform.rotation.y = faceRotation; frameTransform.updateMatrix(); mullions.setMatrixAt(floor * across + column, frameTransform.matrix);
    }
    for (const frames of [verticalFrames, horizontalFrames, mullions]) { frames.instanceMatrix.needsUpdate = true; frames.castShadow = false; frames.receiveShadow = true; scene.add(frames); }
    for (let floor = 0; floor < floors; floor++) addBox(w + 0.1, 0.12, d + 0.1, facadeTrim, x, STREET_Y + (floor + 1) * 2.8, z);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) addBox(0.2, h, 0.2, facadeTrim, x + sx * (w / 2 - 0.1), STREET_Y + h / 2, z + sz * (d / 2 - 0.1));
    for (const side of [-1, 1]) {
      const hvac = addBox(1.25, 0.58, 0.92, roofMetal, x + side * Math.min(w / 4, 3.2), STREET_Y + h + 0.65, z);
      addBox(0.62, 0.12, 0.52, facadeTrim, hvac.position.x, hvac.position.y + 0.35, z);
    }
    for (const side of [-1, 1]) {
      const awning = addBox(1.5, 0.11, 0.75, surfaceMaterial(side < 0 ? 0xa57561 : 0x55736e, 0.7, 0.08), x + side * Math.min(w / 3, 3.5), STREET_Y + 2.2, facing === "north" ? z + d / 2 + 0.42 : facing === "south" ? z - d / 2 - 0.42 : z);
      if (facing === "east" || facing === "west") { awning.rotation.y = Math.PI / 2; awning.position.z = z + side * Math.min(d / 3, 2.5); }
    }
    building.userData.kind = "city-building";
  };
  const signFace = (text: string, x: number, y: number, z: number, width: number, height: number, color: string, rotationY = Math.PI, flipX = false) => {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 128;
    const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#fffaf3"; context.textAlign = "center"; context.textBaseline = "middle"; context.font = "800 54px system-ui, sans-serif"; context.fillText(text, 256, 66, 480);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    sign.position.set(x, y, z); sign.rotation.y = rotationY; sign.scale.x = flipX ? -1 : 1; architecture.add(sign);
  };
  const signHangers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.34, 0.32), roofMetal, 34), signHangerTransform = new THREE.Object3D();
  signHangerTransform.scale.set(0, 0, 0);
  for (let i = 0; i < signHangers.count; i++) { signHangerTransform.updateMatrix(); signHangers.setMatrixAt(i, signHangerTransform.matrix); }
  signHangers.instanceMatrix.needsUpdate = true;
  scene.add(signHangers);
  let signHangerIndex = 0;
  const addSignHangers = (x: number, y: number, z: number, width: number, eastFacing = false) => {
    for (const side of [-1, 1]) { signHangerTransform.position.set(eastFacing ? x : x + side * width * 0.35, y, eastFacing ? z + side * width * 0.35 : z); signHangerTransform.rotation.y = eastFacing ? Math.PI / 2 : 0; signHangerTransform.scale.set(1, 1, 1); signHangerTransform.updateMatrix(); signHangers.setMatrixAt(signHangerIndex++, signHangerTransform.matrix); }
    signHangers.instanceMatrix.needsUpdate = true;
  };
  const uniqueSouthBuilding = (x: number, z: number, w: number, d: number, h: number, color: number, label: string, style: "theater" | "cafe" | "market" | "library" | "hotel" | "tower") => {
    block(x, z, w, d, h, color, "south");
    const front = z - d / 2 - 0.2, signWidth = Math.min(w * 0.78, 8), signY = STREET_Y + 3.02;
    addBox(signWidth + 0.22, 0.64, 0.16, roofMetal, x, signY, front + 0.02);
    addSignHangers(x, signY + 0.49, front + 0.06, signWidth);
    signFace(label, x, signY, front - 0.075, signWidth, 0.56, style === "theater" ? "#71384c" : style === "hotel" ? "#435a71" : style === "library" ? "#4c6654" : "#385f59");
    if (style === "theater") {
      const canopy = addBox(signWidth + 0.9, 0.2, 1.05, surfaceMaterial(0xb35b58, 0.72), x, STREET_Y + 2.58, front - 0.48);
      canopy.castShadow = true;
      for (let i = 0; i < 7; i++) addBox(0.09, 0.07, 0.08, theaterBulbs[i % 2], x - signWidth * 0.42 + i * signWidth * 0.14, STREET_Y + 2.45, front - 0.94);
      for (const side of [-1, 1]) addBox(0.34, 2.8, 0.32, facadeTrim, x + side * (w / 2 - 0.38), STREET_Y + 1.4, front + 0.12);
    } else if (style === "cafe" || style === "market") {
      for (let i = 0; i < 7; i++) addBox(w / 7 + 0.015, 0.16, 0.88, surfaceMaterial(i % 2 ? 0xf3e6cc : style === "cafe" ? 0x66886c : 0xc27758, 0.78), x - w / 2 + (i + 0.5) * w / 7, STREET_Y + 2.48, front - 0.42);
      const planter = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, 0.32, 0.3), surfaceMaterial(0x6d5c49, 0.92));
      planter.position.set(x, STREET_Y + 0.22, front - 0.18); architecture.add(planter);
      for (let i = 0; i < 5; i++) addBox(0.36, 0.42 + (i % 2) * 0.16, 0.25, surfaceMaterial(i % 2 ? 0x4e8b54 : 0x77a95b, 0.9), x - w * 0.25 + i * w * 0.125, STREET_Y + 0.48, front - 0.2);
    } else if (style === "library") {
      for (const side of [-1, 1]) addBox(0.28, 2.9, 0.3, facadeTrim, x + side * (w / 2 - 0.38), STREET_Y + 1.45, front + 0.08);
      addBox(w * 0.66, 0.18, 1.1, roofMetal, x, STREET_Y + 3.9, front - 0.32);
      for (let i = 0; i < 4; i++) addBox(0.12, 2.3, 0.12, surfaceMaterial(0xe1d4bd, 0.8), x - w * 0.25 + i * w / 6, STREET_Y + 1.2, front - 0.05);
    } else if (style === "hotel") {
      addBox(w * 0.62, 0.88, d * 0.62, roofMetal, x, STREET_Y + h + 0.46, z);
      for (let i = 0; i < 3; i++) addBox(0.18, 1.3 + i * 0.35, 0.18, facadeTrim, x - w * 0.2 + i * w * 0.2, STREET_Y + h + 1.15, z);
    } else if (style === "tower") {
      addBox(w * 0.56, 1.0, d * 0.62, surfaceMaterial(0x596a72, 0.6, 0.4), x, STREET_Y + h + 0.52, z);
      addBox(0.24, 2.6, 0.24, facadeTrim, x, STREET_Y + h + 2.3, z);
      addBox(0.55, 0.18, 0.55, roofMetal, x, STREET_Y + h + 3.5, z);
    }
  };
  const uniqueEastBuilding = (x: number, z: number, w: number, d: number, h: number, label: string, style: "cafe" | "lofts" | "market") => {
    const floors = Math.max(3, Math.floor(h / 2.8)), columns = Math.max(3, Math.floor(Math.max(w, d) / 3.1)), paneWidth = 1.15 * Math.min(1, d / (columns + 1) * 0.58), count = floors * columns;
    const verticalFrames = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 1.56, 0.065), windowFrame, count * 2), horizontalFrames = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.07, paneWidth + 0.14), facadeTrim, count * 2), transform = new THREE.Object3D();
    let verticalIndex = 0, horizontalIndex = 0;
    for (let floor = 0; floor < floors; floor++) for (let column = 0; column < columns; column++) {
      const wy = STREET_Y + 1.5 + floor * 2.8, wz = z - d / 2 + (column + 1) * d / (columns + 1), facadeX = x - w / 2;
      for (const side of [-1, 1]) { transform.position.set(facadeX, wy, wz + side * (paneWidth / 2 + 0.035)); transform.updateMatrix(); verticalFrames.setMatrixAt(verticalIndex++, transform.matrix); }
      for (const side of [-1, 1]) { transform.position.set(facadeX, wy + side * 0.77, wz); transform.updateMatrix(); horizontalFrames.setMatrixAt(horizontalIndex++, transform.matrix); }
    }
    verticalFrames.instanceMatrix.needsUpdate = true; horizontalFrames.instanceMatrix.needsUpdate = true;
    verticalFrames.castShadow = horizontalFrames.castShadow = false;
    scene.add(verticalFrames, horizontalFrames);
    const frontX = x - w / 2 - 0.2, signWidth = Math.min(d * 0.78, 8), signY = STREET_Y + 3.1, signColor = style === "cafe" ? "#71384c" : style === "lofts" ? "#435a71" : "#4c6654";
    addBox(0.16, 0.72, signWidth + 0.22, roofMetal, frontX, signY, z);
    addSignHangers(frontX + 0.06, signY + 0.52, z, signWidth, true);
    signFace(label, frontX - 0.09, signY, z, signWidth, 0.64, signColor, -Math.PI / 2, false);
    if (style === "lofts") {
      for (let floor = 1; floor < Math.floor(h / 2.8); floor += 2) {
        const balconyZ = z + (floor % 4 === 1 ? -d * 0.22 : d * 0.22), balconyY = STREET_Y + floor * 2.8;
        addBox(0.78, 0.12, 2.35, facadeTrim, frontX - 0.36, balconyY, balconyZ);
        addBox(0.06, 0.6, 2.35, windowFrame, frontX - 0.75, balconyY + 0.34, balconyZ);
        for (const side of [-1, 1]) addBox(0.55, 0.6, 0.06, windowFrame, frontX - 0.37, balconyY + 0.34, balconyZ + side * 1.14);
      }
    } else {
      const awningMaterial = surfaceMaterial(style === "cafe" ? 0xa57561 : 0x55736e, 0.72);
      addBox(1.05, 0.2, signWidth + 0.9, awningMaterial, frontX - 0.5, STREET_Y + 2.58, z);
      for (let i = 0; i < 7; i++) addBox(0.08, 0.07, 0.08, i % 2 ? facadeTrim : roofMetal, frontX - 1.02, STREET_Y + 2.45, z - signWidth * 0.42 + i * signWidth * 0.14);
      if (style === "cafe") for (const side of [-1, 1]) addBox(0.14, 2.8, 0.14, facadeTrim, frontX - 0.14, STREET_Y + 1.4, z + side * (signWidth / 2 + 0.18));
      else for (const side of [-1, 1]) {
        const planter = addBox(0.42, 0.42, 1.4, facadeTrim, frontX - 0.34, STREET_Y + 0.22, z + side * (signWidth * 0.31));
        planter.castShadow = true;
        for (let leaf = -1; leaf <= 1; leaf++) addBox(0.18, 0.48 + Math.abs(leaf) * 0.12, 0.18, wallMats[(leaf + 2) % wallMats.length], frontX - 0.34, STREET_Y + 0.62, planter.position.z + leaf * 0.32);
      }
    }
  };
  const distantWindows: { mesh: THREE.InstancedMesh; nightColors: THREE.Color[] }[] = [];
  const skylineBlock = (x: number, z: number, w: number, d: number, h: number, color: number) => {
    addBox(w, h, d, wallMats[colors.indexOf(color)] ?? wallMats[0], x, STREET_Y + h / 2, z, true);
    addBox(w + 0.5, 0.42, d + 0.5, facadeTrim, x, STREET_Y + h + 0.2, z);
    const rows = Math.max(3, Math.floor(h / 2.8)), columns = Math.max(3, Math.floor(Math.max(w, d) / 3.1));
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.25, transparent: true, opacity: 0.88 });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.15, 1.25), material, rows * columns * 4);
    const transform = new THREE.Object3D(), nightColors: THREE.Color[] = [];
    let index = 0;
    for (const side of [0, 1, 2, 3]) for (let floor = 0; floor < rows; floor++) for (let column = 0; column < columns; column++) {
      transform.position.set(side < 2 ? x - w / 2 + (column + 1) * w / (columns + 1) : side === 2 ? x + w / 2 + 0.04 : x - w / 2 - 0.04, STREET_Y + 1.5 + floor * 2.8, side < 2 ? side === 0 ? z + d / 2 + 0.04 : z - d / 2 - 0.04 : z - d / 2 + (column + 1) * d / (columns + 1));
      transform.rotation.set(0, side === 1 ? Math.PI : side === 2 ? Math.PI / 2 : side === 3 ? -Math.PI / 2 : 0, 0);
      transform.scale.set(side < 2 ? Math.min(1, w / (columns + 1) * 0.58) : Math.min(1, d / (columns + 1) * 0.58), 1, 1);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      const lit = (floor * 3 + column * 5 + side) % 7 === 0;
      mesh.setColorAt(index, new THREE.Color(0xa9c5d0));
      nightColors.push(new THREE.Color(lit ? 0xffc778 : 0x25323a));
      index++;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    distantWindows.push({ mesh, nightColors });
    for (let floor = 1; floor < Math.floor(h / 4); floor += 2) addBox(w + 0.1, 0.1, d + 0.1, facadeTrim, x, STREET_Y + floor * 4, z);
  };
  block(-7, -40, 17, 10, 16, 0xd9c5b0, "north");
  block(13, -43, 13, 12, 21, 0xb9ccd0, "north");
  block(-20, -37, 8, 10, 11, 0xd6c8aa, "north");
  block(-31, -40, 12, 12, 18, 0xc8d4df, "north");
  block(30, -40, 11, 12, 18, 0xd2bfd4, "north");
  block(-30, -30, 8, 6, 12, 0xd6c8aa, "north");
  block(-9, -30, 12, 6, 15, 0xbccdb5, "north");
  block(4, -30, 7, 6, 11, 0xd9c5b0, "north");
  block(26, -30, 13, 6, 14, 0xc8d4df, "north");
  block(-12, 37, 16, 11, 17, 0xbccdb5, "south");
  block(9, 39, 14, 10, 13, 0xd2bfd4, "south");
  block(-30, 39, 12, 14, 18, 0xb9ccd0, "south");
  block(29, 40, 13, 12, 20, 0xd9c5b0, "south");
  block(-30, 29, 10, 4, 10, 0xd6c8aa, "south");
  block(-7, 29, 9, 4, 12, 0xc8d4df, "south");
  block(7, 29, 8, 4, 9, 0xb9ccd0, "south");
  block(26, 29, 11, 4, 11, 0xd2bfd4, "south");
  block(29, 1, 11, 18, 18, 0xc8d4df, "east");
  skylineBlock(43, -9, 9, 12, 11, 0xd2bfd4); uniqueEastBuilding(43, -9, 9, 12, 11, "HARBOR CAFE", "cafe");
  skylineBlock(52, -9, 8, 12, 15, 0xb9ccd0); uniqueEastBuilding(52, -9, 8, 12, 15, "MILLHOUSE LOFTS", "lofts");
  skylineBlock(60, -6, 8, 10, 13, 0xd9c5b0); uniqueEastBuilding(60, -6, 8, 10, 13, "EASTSIDE MARKET", "market");
  skylineBlock(42.5, 7, 8, 10, 9, 0xc8d4df); uniqueEastBuilding(42.5, 7, 8, 10, 9, "GROVE CAFE", "cafe");
  skylineBlock(52, 7, 9, 10, 17, 0xbccdb5); uniqueEastBuilding(52, 7, 9, 10, 17, "PARKSIDE LOFTS", "lofts");
  skylineBlock(61, 7, 7, 10, 12, 0xd6c8aa); uniqueEastBuilding(61, 7, 7, 10, 12, "CORNER GROCER", "market");
  block(-29, -2, 11, 18, 15, 0xd6c8aa, "west");
  uniqueSouthBuilding(-21.3, 29, 6.2, 4, 12, 0xd2bfd4, "ORPHEUM", "theater");
  uniqueSouthBuilding(0.25, 29, 4.2, 4, 9, 0xbccdb5, "CORNER CAFE", "cafe");
  uniqueSouthBuilding(15.7, 29, 7.8, 4, 10, 0xc8d4df, "MERCADO", "market");
  uniqueSouthBuilding(-22, 39, 2.8, 10, 16, 0xd6c8aa, "LOFTS", "tower");
  uniqueSouthBuilding(-1, 39, 4.4, 10, 14, 0xb9ccd0, "LIBRARY", "library");
  uniqueSouthBuilding(19.2, 39, 5, 10, 17, 0xd9c5b0, "HOTEL", "hotel");
  uniqueSouthBuilding(-47, 53, 14, 11, 20, 0xbccdb5, "PARK HOTEL", "hotel");
  uniqueSouthBuilding(-25, 53, 14, 11, 18, 0xd6c8aa, "STUDIOS", "library");
  uniqueSouthBuilding(-3, 53, 16, 12, 25, 0xc8d4df, "NORTH TOWER", "tower");
  uniqueSouthBuilding(19, 53, 16, 12, 22, 0xd2bfd4, "CITY MARKET", "market");
  uniqueSouthBuilding(45, 53, 14, 11, 19, 0xd9c5b0, "GRAND THEATRE", "theater");
  block(-45, -55, 13, 10, 20, 0xd2bfd4, "north");
  block(-22, -55, 15, 11, 25, 0xbccdb5, "north");
  block(2, -55, 17, 10, 22, 0xd9c5b0, "north");
  block(25, -55, 15, 12, 27, 0xb9ccd0, "north");
  block(49, -55, 15, 11, 21, 0xc8d4df, "north");
  skylineBlock(-55, -71, 16, 12, 33, 0xb9ccd0);
  skylineBlock(-31, -73, 19, 13, 25, 0xd9c5b0);
  skylineBlock(-7, -74, 15, 11, 39, 0xc8d4df);
  skylineBlock(18, -73, 21, 12, 29, 0xbccdb5);
  skylineBlock(48, -70, 16, 14, 36, 0xd2bfd4);
  skylineBlock(-54, 71, 18, 13, 30, 0xd6c8aa);
  skylineBlock(-25, 73, 21, 12, 38, 0xc8d4df);
  skylineBlock(4, 74, 16, 12, 27, 0xd9c5b0);
  skylineBlock(31, 73, 20, 13, 35, 0xb9ccd0);
  skylineBlock(56, 70, 13, 12, 24, 0xbccdb5);
  buildStreetTrees(scene, [[-24, 15, 1], [-20, -16, 0.9], [-22, 4, 1.1], [20, 15, 1], [24, -14, 0.9], [24, 7, 1.15], [-12, -26, 0.82], [6, -26, 1.05], [13, 15, 0.9], [-14, 27, 1.1]], colliders);
  const lamp = (x: number, z: number) => {
    const dark = surfaceMaterial(0x3f484e, 0.42, 0.66);
    addBox(0.38, 0.26, 0.38, dark, x, STREET_Y + 0.13, z);
    addBox(0.1, 4.8, 0.1, dark, x, STREET_Y + 2.5, z);
    addBox(0.9, 0.08, 0.08, dark, x + 0.38, STREET_Y + 4.85, z);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffe8b2 }));
    bulb.position.set(x + 0.75, STREET_Y + 4.7, z);
    const glow = new THREE.PointLight(0xffd89a, 2.2, 9, 2);
    glow.position.copy(bulb.position);
    bulb.visible = false;
    glow.visible = false;
    scene.add(bulb, glow);
    lamps.push({ bulb, glow });
  };
  for (const x of [-22, -10, 3, 17, 25]) lamp(x, 15.5);
  for (const x of [-24, -12, 2, 15, 25]) lamp(x, 26);
  for (const x of [-22, -10, 3, 17, 25]) lamp(x, -16.5);
  for (const x of [-24, -12, 2, 15, 25]) lamp(x, -26);
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x30363a, roughness: 0.98 });
  scene.userData.outdoorAsphalt = asphalt;
  const curb = new THREE.MeshStandardMaterial({ color: 0xaaa9a2, roughness: 0.9 });
  const laneMark = new THREE.MeshStandardMaterial({ color: 0xe9e4d5, roughness: 0.9 });
  const curbGaps: [number, number][] = [[-74, -73.2], [-66.8, 66.8], [73.2, 74]];
  const drivewayCurbGaps: [number, number][] = [[-74, -73.2], [-66.8, -22], [-14, 66.8], [73.2, 74]];
  addBox(148, 0.1, 6.4, asphalt, 0, STREET_Y - 0.025, -21.5);
  for (const z of [-17.7, -25.3]) for (const [x0, x1] of curbGaps) addBox(x1 - x0, 0.12, 1.2, curb, (x0 + x1) / 2, STREET_Y - 0.01, z);
  for (let x = -64; x <= 64; x += 6.4) addBox(3.2, 0.025, 0.12, laneMark, x, STREET_Y + 0.04, -21.5);
  addBox(148, 0.1, 6.4, asphalt, 0, STREET_Y - 0.025, 21.5);
  for (const z of [17.7, 25.3]) for (const [x0, x1] of z === 17.7 ? drivewayCurbGaps : curbGaps) addBox(x1 - x0, 0.12, 1.2, curb, (x0 + x1) / 2, STREET_Y - 0.01, z);
  for (let x = -64; x <= 64; x += 6.4) addBox(3.2, 0.025, 0.12, laneMark, x, STREET_Y + 0.04, 21.5);
  for (const x of [-70, 70]) {
    addBox(6.4, 0.1, 148, asphalt, x, STREET_Y - 0.025, 0);
    for (const curbX of [x - 3.8, x + 3.8]) for (const [z0, z1] of [[-74, -24.7], [-18.3, 18.3], [24.7, 74]] as [number, number][]) addBox(1.2, 0.12, z1 - z0, curb, curbX, STREET_Y - 0.01, (z0 + z1) / 2);
    for (let z = -64; z <= 64; z += 6.4) addBox(0.12, 0.025, 3.2, laneMark, x, STREET_Y + 0.04, z);
  }
  for (const bounds of [
    [new THREE.Vector3(-83, STREET_Y, -83), new THREE.Vector3(-80, 28, 83)],
    [new THREE.Vector3(80, STREET_Y, -83), new THREE.Vector3(83, 28, 83)],
    [new THREE.Vector3(-83, STREET_Y, -83), new THREE.Vector3(83, 28, -80)],
    [new THREE.Vector3(-83, STREET_Y, 80), new THREE.Vector3(83, 28, 83)]
  ] as [THREE.Vector3, THREE.Vector3][]) colliders.push(new THREE.Box3(bounds[0], bounds[1]));
  const garageStripe = new THREE.MeshStandardMaterial({ color: 0xc6a54b, roughness: 0.88 });
  for (const x of [-13.5, -10.5, -7.5, -4.5, -1.5, 1.5, 4.5, 7.5, 10.5, 13.5]) {
    addBox(0.055, 0.025, 6.2, garageStripe, x, STREET_Y + 0.025, -6.7);
    addBox(0.055, 0.025, 6.2, garageStripe, x, STREET_Y + 0.025, 6.7);
    const number = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.025, 0.8), surfaceMaterial(0xbec7cb, 0.8));
    number.position.set(x + 0.65, STREET_Y + 0.03, -5.5);
    architecture.add(number);
  }
  const hazard = new THREE.MeshStandardMaterial({ color: 0xb99139, roughness: 0.72 });
  for (const x of [-14.8, -9.6, 0, 9.6, 14.8]) {
    addBox(0.55, 0.4, 0.55, hazard, x, STREET_Y + 0.2, 0);
    addBox(0.08, 0.18, 0.6, roofMetal, x, STREET_Y + 0.49, 0);
  }
  const bollard = new THREE.MeshStandardMaterial({ color: 0xc1c3bd, roughness: 0.63, metalness: 0.18 });
  for (const x of [-19.5, -17, 15.5, 18]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.8, 10), bollard);
    post.position.set(x, STREET_Y + 0.4, 15.8);
    post.castShadow = true;
    architecture.add(post);
  }
  const clouds = new THREE.Group();
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xf5f5ef, transparent: true, opacity: 0.76, depthWrite: false });
  for (const [x, y, z, scale] of [[-35, 17, -25, 1], [-12, 20, 33, 1.2], [18, 18, -37, 1.1], [38, 20, 26, 0.9], [2, 23, 46, 1.35]] as [number, number, number, number][]) {
    const puff = new THREE.Group();
    for (const [dx, dy, radius] of [[0, 0, 3.3], [3.2, -0.5, 2.5], [-3, -0.6, 2.6], [1.3, 1.6, 2.1]] as [number, number, number][]) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), cloudMat);
      mesh.position.set(dx, dy, 0);
      mesh.scale.y = 0.68;
      puff.add(mesh);
    }
    puff.position.set(x, y, z);
    puff.scale.setScalar(scale);
    clouds.add(puff);
  }
  clouds.name = "outdoor-clouds";
  scene.add(clouds);
  scene.userData.outdoorLamps = lamps;
  scene.userData.cityWindows = windows;
  scene.userData.distantWindows = distantWindows;
  const halloween = new THREE.Group(), christmas = new THREE.Group(), pumpkinMaterial = surfaceMaterial(0xdd742a, 0.7), stemMaterial = surfaceMaterial(0x645638, 0.88), faceMaterial = new THREE.MeshStandardMaterial({ color: 0xffbd5f, emissive: 0xffa42e, emissiveIntensity: 0.65, roughness: 0.7 });
  const pumpkinGeometry = new THREE.SphereGeometry(0.28, 28, 18), pumpkinPositions = pumpkinGeometry.attributes.position;
  for (let i = 0; i < pumpkinPositions.count; i++) { const x = pumpkinPositions.getX(i), y = pumpkinPositions.getY(i), z = pumpkinPositions.getZ(i), rib = 1 + Math.cos(Math.atan2(x, z) * 9) * 0.055; pumpkinPositions.setXYZ(i, x * rib, y * 0.76, z * rib); } pumpkinGeometry.computeVertexNormals();
  const eyeShape = new THREE.Shape(); eyeShape.moveTo(-0.045, 0); eyeShape.lineTo(0.045, 0); eyeShape.lineTo(0, 0.065); eyeShape.closePath(); const pumpkinEye = new THREE.ShapeGeometry(eyeShape);
  for (const z of [-26.4, 26.4]) for (const x of [-24, -12, 2, 15, 25]) { const pumpkin = new THREE.Group(), flesh = new THREE.Mesh(pumpkinGeometry, pumpkinMaterial), stem = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.032, 0.095, 8), stemMaterial); flesh.position.y = 0.21; stem.position.set(0, 0.43, 0); pumpkin.add(flesh, stem); for (const side of [-1, 1]) { const eye = new THREE.Mesh(pumpkinEye, faceMaterial); eye.position.set(side * 0.1, 0.23, 0.257); pumpkin.add(eye); } const grin = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.016, 6, 18, Math.PI), faceMaterial); grin.rotation.z = Math.PI; grin.position.set(0, 0.15, 0.264); pumpkin.add(grin); pumpkin.position.set(x, STREET_Y + 0.02, z); pumpkin.rotation.y = z > 0 ? Math.PI : 0; pumpkin.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); halloween.add(pumpkin); }
  const snowMaterial = surfaceMaterial(0xf4f5ee, 0.94), coalMaterial = surfaceMaterial(0x26323a, 0.76), scarfMaterial = surfaceMaterial(0xb5514b, 0.84);
  for (const x of [-29, 29]) { const snowman = new THREE.Group(); for (const [y, radius] of [[0.43, 0.44], [0.98, 0.32], [1.4, 0.23]]) { const ball = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), snowMaterial); ball.position.y = y; ball.castShadow = true; snowman.add(ball); } for (const side of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), coalMaterial); eye.position.set(side * 0.07, 1.43, 0.215); snowman.add(eye); } const nose = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 10), pumpkinMaterial); nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.37, 0.31); snowman.add(nose); const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.045, 8, 24), scarfMaterial); scarf.rotation.x = Math.PI / 2; scarf.position.y = 1.21; snowman.add(scarf); snowman.position.set(x, STREET_Y, 14); christmas.add(snowman); }
  const holidayLights: THREE.MeshStandardMaterial[] = [];
  for (const x of [-22, -10, 3, 17, 25]) { const wire = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.018, 6, 14), stemMaterial); wire.position.set(x, STREET_Y + 3.2, 15.5); christmas.add(wire); for (let i = 0; i < 6; i++) { const material = new THREE.MeshStandardMaterial({ color: [0xd75145, 0x73b974, 0xebc365][i % 3], emissive: [0xd75145, 0x73b974, 0xebc365][i % 3], emissiveIntensity: 1, roughness: 0.25 }), bulb = new THREE.Mesh(new THREE.SphereGeometry(0.047, 12, 8), material); bulb.position.set(x + Math.cos(i * Math.PI / 3) * 0.14, STREET_Y + 3.2 + Math.sin(i * Math.PI / 3) * 0.14, 15.54); holidayLights.push(material); christmas.add(bulb); } }
  const holidayBounds: { group: THREE.Group; box: THREE.Box3; height: number }[] = [];
  for (const group of [halloween, christmas]) for (const prop of group.children) { if (!(prop instanceof THREE.Group)) continue; const box = new THREE.Box3().setFromObject(prop), height = box.max.y - STREET_Y; colliders.push(box); holidayBounds.push({ group, box, height }); }
  halloween.visible = christmas.visible = false; scene.add(halloween, christmas); scene.userData.outdoorHoliday = { halloween, christmas, lights: holidayLights, bounds: holidayBounds };
  const treeBatches = scene.userData.treeBatches as TreeBatch[], falling = new THREE.InstancedMesh(treeBatches[0].leaves.geometry, surfaceMaterial(0xc58b45, 0.9).clone(), 64); (falling.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide; falling.visible = false; falling.frustumCulled = false; scene.add(falling); scene.userData.outdoorFallingLeaves = falling; scene.userData.outdoorLeafCentres = treeBatches.flatMap((batch) => batch.centres); scene.userData.outdoorLeafTransform = new THREE.Object3D();
  mergeStaticMeshes(architecture);
  updateOutdoor(scene, 0);
  return colliders;
}

export function buildStreetTrees(scene: THREE.Scene, trees: [number, number, number][], colliders?: THREE.Box3[], trunkHeight = 2.2, trunkRadius = 0.27): void {
  const bark = surfaceMaterial(0x684c3c, 0.94), treeTransform = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0), canopyOffset = trunkHeight - 2.2;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(trunkRadius * 0.6, trunkRadius, trunkHeight, 14), bark, trees.length), branches = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.045, 0.1, 1, 10), bark, trees.length * 3), crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), surfaceMaterial(0xffffff, 0.95), trees.length * 4);
  const leafGeometry = new THREE.BufferGeometry(), leafPositions: number[] = [], leafIndices: number[] = [];
  for (let row = 0; row <= 8; row++) { const t = row / 8, width = Math.sin(t * Math.PI) ** 0.78 * 0.3, bend = Math.sin(t * Math.PI) * 0.13; leafPositions.push(-width, t, bend * 0.45, 0, t, bend, width, t, bend * 0.45); if (row < 8) { const i = row * 3; leafIndices.push(i, i + 3, i + 1, i + 1, i + 3, i + 4, i + 1, i + 4, i + 2, i + 2, i + 4, i + 5); } }
  leafGeometry.setAttribute("position", new THREE.Float32BufferAttribute(leafPositions, 3)); leafGeometry.setIndex(leafIndices); leafGeometry.computeVertexNormals();
  const foliage = surfaceMaterial(0xffffff, 0.94).clone(); foliage.side = THREE.DoubleSide;
  const leaves = new THREE.InstancedMesh(leafGeometry, foliage, trees.length * 37), leafColors = [new THREE.Color(0x438f4d), new THREE.Color(0x5fae5c), new THREE.Color(0x79bd6a)];
  trees.forEach(([x, z, scale], treeIndex) => {
    treeTransform.position.set(x, STREET_Y + trunkHeight / 2 * scale, z); treeTransform.rotation.set(0, 0, 0); treeTransform.scale.setScalar(scale); treeTransform.updateMatrix(); trunks.setMatrixAt(treeIndex, treeTransform.matrix);
    const phase = Math.sin(x * 0.37 + z * 0.19) * Math.PI;
    for (let branch = 0; branch < 3; branch++) { const angle = phase + branch * Math.PI * 2 / 3, start = new THREE.Vector3(x, STREET_Y + (1.65 + branch * 0.12 + canopyOffset) * scale, z), end = new THREE.Vector3(x + Math.cos(angle) * 0.77 * scale, STREET_Y + (2.95 - branch * 0.08 + canopyOffset) * scale, z + Math.sin(angle) * 0.77 * scale), direction = end.clone().sub(start); treeTransform.position.copy(start.add(end).multiplyScalar(0.5)); treeTransform.quaternion.setFromUnitVectors(up, direction.clone().normalize()); treeTransform.scale.set(scale, direction.length(), scale); treeTransform.updateMatrix(); branches.setMatrixAt(treeIndex * 3 + branch, treeTransform.matrix); }
    for (const [cluster, dx, dy, dz, radius] of [[0, 0, 2.7, 0, 0.94], [1, 0.61, 3.0, 0.13, 0.66], [2, -0.56, 3.02, -0.16, 0.72], [3, 0.07, 3.52, -0.05, 0.62]]) { treeTransform.position.set(x + dx * scale, STREET_Y + (dy + canopyOffset) * scale, z + dz * scale); treeTransform.rotation.set(0.12 * cluster, phase, 0.1 * cluster); treeTransform.scale.set(radius * scale, radius * scale * 0.62, radius * scale * 0.86); treeTransform.updateMatrix(); crowns.setMatrixAt(treeIndex * 4 + cluster, treeTransform.matrix); crowns.setColorAt(treeIndex * 4 + cluster, leafColors[cluster % 3]); }
    let leafIndex = treeIndex * 37;
    for (let layer = 0; layer < 4; layer++) { const count = [9, 12, 10, 6][layer], radius = [0.81, 0.95, 0.67, 0.28][layer], height = [2.15, 2.57, 3.05, 3.52][layer]; for (let i = 0; i < count; i++) { const angle = phase + i * Math.PI * 2 / count + layer * 0.39, direction = new THREE.Vector3(Math.cos(angle), layer === 3 ? 0.6 : 0.08 + layer * 0.12, Math.sin(angle)).normalize(); treeTransform.position.set(x + Math.cos(angle) * radius * scale, STREET_Y + (height + canopyOffset) * scale, z + Math.sin(angle) * radius * scale); treeTransform.quaternion.setFromUnitVectors(up, direction); treeTransform.scale.set(scale * (0.8 + (i % 3) * 0.1), scale * (0.75 + (i % 4) * 0.06), scale); treeTransform.updateMatrix(); leaves.setMatrixAt(leafIndex, treeTransform.matrix); leaves.setColorAt(leafIndex++, leafColors[(i + layer + treeIndex) % 3]); } }
    colliders?.push(new THREE.Box3(new THREE.Vector3(x - trunkRadius * scale, STREET_Y, z - trunkRadius * scale), new THREE.Vector3(x + trunkRadius * scale, STREET_Y + trunkHeight * scale, z + trunkRadius * scale)));
  });
  for (const mesh of [trunks, branches, crowns, leaves]) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; mesh.castShadow = mesh.receiveShadow = true; mesh.computeBoundingSphere(); scene.add(mesh); }
  const batches = (scene.userData.treeBatches ??= []) as TreeBatch[]; batches.push({ crowns, leaves, centres: trees.map(([x, z, scale]) => [x, z, scale]), phase: batches.length * 1.7 });
}

export function updateOutdoor(scene: THREE.Scene, dt: number, season = "auto", weather = "sunny", wind = 0.2, date = new Date()): void {
  const elapsed = (scene.userData.outdoorTime as number | undefined ?? 0) + dt; scene.userData.outdoorTime = elapsed;
  const month = date.getMonth(), activeSeason = season === "auto" ? month === 11 || month < 2 ? "winter" : month < 5 ? "spring" : month < 8 ? "summer" : "autumn" : season, snowy = weather === "snow", palette = activeSeason === "autumn" ? [0xa96c35, 0xc99549, 0xdbb46a] : activeSeason === "spring" ? [0x76ac63, 0x95c778, 0xc9dba1] : [0x438f4d, 0x5fae5c, 0x79bd6a], batches = (scene.userData.treeBatches as TreeBatch[] | undefined) ?? [], state = `${activeSeason}:${snowy}`;
  for (const batch of batches) { batch.leaves.position.x = Math.sin(elapsed * 1.6 + batch.phase) * wind * 0.04; batch.leaves.position.z = Math.cos(elapsed * 1.2 + batch.phase) * wind * 0.025; }
  if (scene.userData.outdoorSeason !== state) { scene.userData.outdoorSeason = state; for (const batch of batches) { batch.leaves.visible = activeSeason !== "winter"; batch.crowns.visible = activeSeason !== "winter" || snowy; for (const mesh of [batch.crowns, batch.leaves]) { for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, new THREE.Color(snowy ? 0xe6ecea : palette[i % palette.length])); if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; } } const lawn = scene.userData.outdoorLawn as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | undefined; lawn?.material.color.setHex(snowy ? 0xe6ece7 : activeSeason === "winter" ? 0xb0b79a : activeSeason === "autumn" ? 0xb6bd8b : 0xa5c68d); }
  const asphalt = scene.userData.outdoorAsphalt as THREE.MeshStandardMaterial | undefined; if (asphalt) asphalt.roughness = weather.includes("rain") || weather === "drizzle" ? 0.38 : 0.98;
  const holiday = scene.userData.outdoorHoliday as { halloween: THREE.Group; christmas: THREE.Group; lights: THREE.MeshStandardMaterial[]; bounds: { group: THREE.Group; box: THREE.Box3; height: number }[] } | undefined; if (holiday) { holiday.halloween.visible = month === 9; holiday.christmas.visible = month === 11; holiday.lights.forEach((material, i) => material.emissiveIntensity = 0.8 + Math.sin(elapsed * 2 + i * 0.7) * 0.3); for (const { group, box, height } of holiday.bounds) { box.min.y = group.visible ? STREET_Y : 100; box.max.y = box.min.y + height; } }
  const falling = scene.userData.outdoorFallingLeaves as THREE.InstancedMesh | undefined; if (falling) { falling.visible = activeSeason === "autumn"; if (falling.visible) { const centres = scene.userData.outdoorLeafCentres as [number, number, number][], transform = scene.userData.outdoorLeafTransform as THREE.Object3D; for (let i = 0; i < falling.count; i++) { const [x, z, scale] = centres[i % centres.length], age = (elapsed * (0.14 + i % 4 * 0.014) + i * 0.173) % 1; transform.position.set(x + Math.sin(i * 1.9 + elapsed * 0.8) * scale + age * wind * 2, STREET_Y + (1 - age) * 3.8 * scale, z + Math.cos(i * 0.7 + elapsed * 0.5) * scale); transform.rotation.set(elapsed + i, i * 0.7, elapsed * 0.6 + i); transform.scale.setScalar(0.09); transform.updateMatrix(); falling.setMatrixAt(i, transform.matrix); } falling.instanceMatrix.needsUpdate = true; } }
}

export function setOutdoorNight(scene: THREE.Scene, night: boolean): void {
  for (const lamp of (scene.userData.outdoorLamps as { bulb: THREE.Mesh; glow: THREE.PointLight }[] | undefined) ?? []) {
    lamp.bulb.visible = night;
    lamp.glow.visible = night;
  }
  for (const pane of (scene.userData.cityWindows as THREE.Mesh[] | undefined) ?? []) {
    const material = pane.material as THREE.MeshStandardMaterial;
    material.color.setHex(night ? pane.userData.nightColor as number : pane.userData.dayColor as number);
    material.emissive.setHex(night ? pane.userData.nightEmissive as number : pane.userData.dayEmissive as number);
    material.emissiveIntensity = night ? 0.52 : 0.08;
  }
  for (const city of (scene.userData.distantWindows as { mesh: THREE.InstancedMesh; nightColors: THREE.Color[] }[] | undefined) ?? []) {
    for (let i = 0; i < city.nightColors.length; i++) city.mesh.setColorAt(i, night ? city.nightColors[i] : new THREE.Color(0xa9c5d0));
    if (city.mesh.instanceColor) city.mesh.instanceColor.needsUpdate = true;
  }
}
