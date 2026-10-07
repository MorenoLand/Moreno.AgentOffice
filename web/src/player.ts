import * as THREE from "three";
import type { Office } from "./office";
import { surfaceMaterial } from "./materials";
import type { VehiclePose } from "./driving";

const RADIUS = 0.33;
const WALK = 3.1;
const VR_WALK = 2.2;
const RUN = 5.4;
export const SKIN = 0xf0c9a4;
export const HAIR = 0xfcd370;
export const HAIR_LOW = 0xdca465;
export const LEGS = 0x433f55;

export interface Figure {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Group;
  armR: THREE.Group;
  head: THREE.Group;
  legSpacing: number;
  legY: number;
}

function capsule(radius: number, length: number, color: number, segments = 16, roughness = 0.86, metalness = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, segments), surfaceMaterial(color, roughness, metalness));
  mesh.castShadow = true;
  return mesh;
}

function buildLegs(adult = false): [THREE.Group, THREE.Group] {
  const left = new THREE.Group();
  const right = new THREE.Group();
  for (const [group, sign] of [[left, -1], [right, 1]] as [THREE.Group, number][]) {
    const leg = capsule(adult ? 0.09 : 0.095, adult ? 0.36 : 0.18, LEGS, 16, adult ? 0.94 : 0.37, adult ? 0 : 0.4);
    leg.position.y = adult ? -0.22 : -0.17;
    const shoe = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.11, 5, 18), surfaceMaterial(0x33304a, 0.66));
    shoe.rotation.x = Math.PI / 2;
    shoe.scale.set(1, 1.35, 0.72);
    shoe.position.set(0, adult ? -0.49 : -0.36, 0.045);
    shoe.castShadow = true;
    group.add(leg, shoe);
    const sole = new THREE.Mesh(new THREE.CapsuleGeometry(0.083, 0.11, 4, 18), surfaceMaterial(0x20202a, 0.96));
    sole.rotation.x = Math.PI / 2; sole.scale.set(1.03, 1.36, 0.2); sole.position.set(0, adult ? -0.538 : -0.408, 0.045); group.add(sole);
    if (adult) {
      const seam = capsule(0.004, 0.35, new THREE.Color(LEGS).multiplyScalar(0.8).getHex(), 8); seam.position.set(sign * 0.075, -0.225, 0.048); group.add(seam);
      for (const z of [0.055, 0.082, 0.109]) { const lace = capsule(0.004, 0.085, 0xb8b6c2, 8); lace.rotation.z = Math.PI / 2; lace.position.set(0, -0.443, z); group.add(lace); }
    } else {
      const ankle = new THREE.Mesh(new THREE.CylinderGeometry(0.069, 0.069, 0.06, 18), surfaceMaterial(0x727b86, 0.3, 0.7)); ankle.position.y = -0.32; group.add(ankle);
    }
    group.position.set(sign * (adult ? 0.14 : 0.13), adult ? 0.53 : 0.39, 0);
  }
  return [left, right];
}

function buildArms(color: number, handColor = color, adult = false): [THREE.Group, THREE.Group] {
  const left = new THREE.Group();
  const right = new THREE.Group();
  for (const [group, sign] of [[left, -1], [right, 1]] as [THREE.Group, number][]) {
    const arm = capsule(adult ? 0.058 : 0.065, adult ? 0.43 : 0.28, color, 16, adult ? 0.9 : 0.34, adult ? 0 : 0.42);
    arm.position.y = adult ? -0.28 : -0.18;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(adult ? 0.05 : 0.055, 18, 14), surfaceMaterial(handColor, adult ? 0.62 : 0.36, adult ? 0 : 0.3));
    hand.position.set(0, adult ? -0.57 : -0.37, 0.025);
    group.position.set(sign * (adult ? 0.255 : 0.225), adult ? 1.12 : 0.72, 0);
    group.rotation.z = sign * (adult ? 0.08 : 0.08);
    group.add(arm, hand);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(adult ? 0.06 : 0.052, adult ? 0.06 : 0.052, adult ? 0.042 : 0.056, 18), surfaceMaterial(adult ? new THREE.Color(color).multiplyScalar(0.72).getHex() : 0x65707a, adult ? 0.94 : 0.3, adult ? 0 : 0.65));
    cuff.position.y = adult ? -0.515 : -0.315; group.add(cuff);
    if (!adult) { const joint = new THREE.Mesh(new THREE.SphereGeometry(0.066, 18, 12), surfaceMaterial(0x555d67, 0.28, 0.72)); joint.position.y = -0.035; group.add(joint); }
  }
  return [left, right];
}

export function buildHuman(color: number, hairColor = HAIR): Figure {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const [legL, legR] = buildLegs(true);
  const [armL, armR] = buildArms(color, SKIN, true);
  body.add(legL, legR, armL, armR);

  const profile: [number, number][] = [[0, 0], [0.16, 0], [0.185, 0.05], [0.2, 0.18], [0.22, 0.38], [0.225, 0.54], [0.21, 0.62], [0.175, 0.72], [0.08, 0.76], [0, 0.77]];
  const torso = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), 32), surfaceMaterial(color, 0.92));
  torso.position.y = 0.5;
  torso.scale.set(0.98, 0.84, 0.82);
  torso.castShadow = true;
  torso.receiveShadow = true;
  body.add(torso);
  const garmentTone = surfaceMaterial(new THREE.Color(color).multiplyScalar(0.76).getHex(), 0.96);
  const placket = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.12, 2, 6), garmentTone);
  placket.position.set(0, 0.91, 0.181); body.add(placket);
  for (const y of [0.91, 0.97, 1.03]) {
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 8), surfaceMaterial(0xf4dfad, 0.38));
    button.position.set(0, y, 0.195); body.add(button);
  }
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.068, 0.05, 20), surfaceMaterial(SKIN, 0.65));
  neck.position.y = 1.166;
  neck.castShadow = true;
  body.add(neck);
  const neckline = new THREE.Mesh(new THREE.TorusGeometry(0.073, 0.009, 8, 28), garmentTone);
  neckline.rotation.x = Math.PI / 2;
  neckline.position.y = 1.145;
  body.add(neckline);
  for (const sign of [-1, 1]) {
    const collar = new THREE.Mesh(new THREE.SphereGeometry(0.056, 16, 12), surfaceMaterial(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.2).getHex(), 0.91));
    collar.scale.set(0.64, 0.36, 0.16); collar.rotation.z = sign * 0.48; collar.position.set(sign * 0.04, 1.108, 0.118); body.add(collar);
  }
  const pocket = new THREE.Mesh(new THREE.PlaneGeometry(0.058, 0.068), garmentTone); pocket.position.set(0.104, 0.967, 0.162); pocket.rotation.y = 0.3; body.add(pocket);

  const head = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.18, 32, 24), surfaceMaterial(SKIN, 0.65));
  skull.castShadow = true;
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.185, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.43),
    surfaceMaterial(hairColor, 0.88)
  );
  cap.position.y = 0.012;
  cap.castShadow = true;
  const hairBack = new THREE.Mesh(new THREE.SphereGeometry(0.145, 24, 18), surfaceMaterial(hairColor, 0.88));
  hairBack.scale.set(1, 0.8, 0.7); hairBack.position.set(0, -0.015, -0.07); head.add(hairBack);
  for (const sign of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.035, 18, 14), surfaceMaterial(SKIN, 0.65));
    ear.position.set(sign * 0.174, -0.005, 0);
    head.add(ear);
    const innerEar = new THREE.Mesh(new THREE.SphereGeometry(0.021, 12, 10), surfaceMaterial(0xd9a487, 0.75)); innerEar.scale.set(0.4, 0.8, 0.66); innerEar.position.set(sign * 0.197, -0.005, 0.008); head.add(innerEar);
  }
  head.add(skull, cap);
  for (const sign of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 12), surfaceMaterial(0xfaf5ef, 0.3));
    eye.scale.set(1, 0.78, 0.42); eye.position.set(sign * 0.058, -0.026, 0.17);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 14, 10), surfaceMaterial(0x4e5641, 0.28)); iris.scale.z = 0.42; iris.position.set(sign * 0.058, -0.026, 0.178);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0052, 12, 8), surfaceMaterial(0x1c201b, 0.18)); pupil.scale.z = 0.4; pupil.position.set(sign * 0.058, -0.026, 0.182);
    const brow = capsule(0.006, 0.034, new THREE.Color(hairColor).multiplyScalar(0.62).getHex(), 10);
    brow.rotation.z = Math.PI / 2;
    brow.position.set(sign * 0.058, 0.012, 0.165);
    head.add(eye, iris, pupil, brow);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), surfaceMaterial(0xe4b48e, 0.68));
  nose.rotation.x = Math.PI / 2;
  nose.scale.set(0.9, 1.45, 0.9);
  nose.position.set(0, -0.058, 0.175);
  const mouth = new THREE.Mesh(new THREE.CapsuleGeometry(0.004, 0.028, 3, 10), surfaceMaterial(0x925f50, 0.8));
  mouth.rotation.z = Math.PI / 2;
  mouth.scale.z = 0.5;
  mouth.position.set(0, -0.105, 0.15);
  head.add(nose, mouth);
  head.position.y = 1.375;
  body.add(head);
  root.add(body);
  root.scale.setScalar(0.9);
  return { root, body, legL, legR, armL, armR, head, legSpacing: 0.14, legY: 0.53 };
}

export function buildAgent(color: number): Figure {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const [legL, legR] = buildLegs();
  const [armL, armR] = buildArms(color);
  body.add(legL, legR, armL, armR);

  const torso = capsule(0.23, 0.13, color, 24, 0.34, 0.42);
  torso.position.y = 0.57;
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), surfaceMaterial(0x24303a, 0.42, 0.32));
  belly.position.set(0, 0.57, 0.23);
  const chestPanel = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.13, 6, 18), surfaceMaterial(0x24303a, 0.3, 0.45));
  chestPanel.scale.set(0.9, 1, 0.34); chestPanel.position.set(0, 0.6, 0.207);
  body.add(torso, belly, chestPanel);
  const waist = new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.007, 8, 32), surfaceMaterial(0x606c78, 0.3, 0.7)); waist.rotation.x = Math.PI / 2; waist.position.y = 0.46; body.add(waist);
  for (const y of [0.65, 0.67, 0.69]) { const vent = capsule(0.0035, 0.045, 0x75858c, 8, 0.3, 0.7); vent.rotation.z = Math.PI / 2; vent.position.set(0, y, 0.23); body.add(vent); }

  const head = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 24), surfaceMaterial(color, 0.32, 0.38));
  skull.castShadow = true;
  const visor = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.06, 0.22, 4, 12),
    new THREE.MeshPhysicalMaterial({ color: 0x1b2430, roughness: 0.18, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 })
  );
  visor.rotation.z = Math.PI / 2;
  visor.scale.z = 0.35;
  visor.position.z = 0.208;
  for (const sign of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.017, 16, 12), new THREE.MeshStandardMaterial({ color: 0x8df4df, emissive: 0x60cbbb, emissiveIntensity: 0.7, roughness: 0.2 }));
    eye.position.set(sign * 0.075, 0, 0.236);
    head.add(eye);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.024, 24), surfaceMaterial(0x667581, 0.28, 0.75)); hinge.rotation.z = Math.PI / 2; hinge.position.set(sign * 0.215, 0, 0); head.add(hinge);
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.028, 12), surfaceMaterial(0x26333e, 0.3, 0.65)); screw.rotation.z = Math.PI / 2; screw.position.copy(hinge.position); head.add(screw);
  }
  for (const sign of [-1, 1]) {
    const status = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 10), new THREE.MeshStandardMaterial({ color: sign < 0 ? 0xffd17f : 0x8df4df, emissive: sign < 0 ? 0xffaf4d : 0x63cbbb, emissiveIntensity: 0.55, roughness: 0.25 }));
    status.position.set(sign * 0.045, 0.59, 0.237); body.add(status);
  }
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.13, 20), surfaceMaterial(0x687c89, 0.25, 0.85));
  stem.position.y = 0.26;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.058, 24, 18), new THREE.MeshStandardMaterial({ color: 0x7ef2d0, emissive: 0x5fceb4, emissiveIntensity: 0.7, roughness: 0.24 }));
  bulb.position.y = 0.35;
  head.add(skull, visor, stem, bulb);
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.04, 0.025, 24), surfaceMaterial(0x445360, 0.28, 0.7)); socket.position.y = 0.219; head.add(socket);
  head.position.y = 1.01;
  body.add(head);
  root.add(body);
  return { root, body, legL, legR, armL, armR, head, legSpacing: 0.13, legY: 0.39 };
}

export function setWalking(figure: Figure, phase: number, moving: boolean, idle: number): void {
  const swing = moving ? Math.sin(phase * 10) : 0;
  figure.legL.rotation.x = swing * 0.62;
  figure.legR.rotation.x = -swing * 0.62;
  figure.legL.position.set(-figure.legSpacing, figure.legY, 0);
  figure.legR.position.set(figure.legSpacing, figure.legY, 0);
  figure.armL.rotation.x = -swing * 0.35;
  figure.armR.rotation.x = swing * 0.35;
  figure.body.position.y = moving ? Math.abs(Math.sin(phase * 10)) * 0.045 : Math.sin(idle * 1.9) * 0.012;
  figure.body.rotation.z = moving ? Math.sin(phase * 10) * 0.035 : 0;
  figure.head.rotation.y = moving ? 0 : Math.sin(idle * 0.7) * 0.22;
}

export function setSitting(figure: Figure, amount: number, idle: number): void {
  figure.legL.rotation.x = -1.05 * amount;
  figure.legR.rotation.x = -1.05 * amount;
  figure.legL.position.z = 0.18 * amount;
  figure.legR.position.z = 0.18 * amount;
  figure.legL.position.y = figure.legY - 0.04 * amount;
  figure.legR.position.y = figure.legY - 0.04 * amount;
  figure.armL.rotation.x = -0.65 * amount;
  figure.armR.rotation.x = -0.65 * amount;
  figure.body.position.y = -0.14 * amount + Math.sin(idle * 1.6) * 0.008;
  figure.head.rotation.y = Math.sin(idle * 0.6) * 0.14;
  figure.body.rotation.z = 0;
}

export class Player {
  readonly figure: Figure;
  private firstPersonHands: THREE.Group;
  private firstPersonRightArm!: THREE.Group;
  private reachTimer = -1;
  x = 0;
  z = 6.2;
  yaw = 0;
  pitch = Math.atan2(1.8, 4.6);
  facing = Math.PI;
  phase = 0;
  jumpHeight = 0;
  seated = false;
  lookEnabled = true;
  private firstPerson = false;
  private xrMode = false;
  private xrForward = 0;
  private xrStrafe = 0;
  private xrMoveYaw = 0;
  private xrSavedView?: { firstPerson: boolean; yaw: number; pitch: number; zoom: number };
  private transportLocked = false;
  private vehiclePose: VehiclePose | null = null;
  private vehicleCameraReady = false;
  private readonly vehicleCameraPosition = new THREE.Vector3();
  private readonly vehicleCameraTarget = new THREE.Vector3();
  private groundY = 0;
  private seatGroundY = 0;
  private jumpVelocity = 0;
  private zoom = Math.hypot(4.6, 1.8);
  private keys = new Set<string>();
  private dragging = false;
  private rightLooking = false;
  private relockAfterAlt = false;
  private altUsedOnUI = false;
  private altPointerOverUI = false;

  constructor(private office: Office) {
    this.figure = buildHuman(0x557dd4);
    office.scene.add(this.figure.root);
    this.firstPersonHands = new THREE.Group();
    const sleeve = surfaceMaterial(0x557dd4, 0.92).clone();
    const skin = surfaceMaterial(SKIN, 0.65).clone();
    sleeve.depthTest = skin.depthTest = true;
    sleeve.depthWrite = skin.depthWrite = false;
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.42, 6, 14).rotateX(Math.PI / 2), sleeve);
      forearm.position.z = 0.34;
      forearm.renderOrder = 1000;
      arm.add(forearm);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.045, 18).rotateX(Math.PI / 2), sleeve);
      cuff.position.z = 0.075;
      cuff.renderOrder = 1000;
      arm.add(cuff);
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.062, 18, 14), skin);
      palm.scale.set(1, 0.78, 1.18);
      palm.renderOrder = 1001;
      arm.add(palm);
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.03, 4, 10).rotateX(Math.PI / 2), skin);
      thumb.position.set(-side * 0.05, 0.014, -0.02);
      thumb.rotation.y = side * 0.55;
      thumb.renderOrder = 1001;
      arm.add(thumb);
      if (side === 1) {
        const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.019, 0.05, 4, 10).rotateX(Math.PI / 2), skin);
        finger.position.set(-0.016, 0.022, -0.085);
        finger.renderOrder = 1001;
        arm.add(finger);
      }
      arm.position.set(side * 0.25, -0.185, -0.44);
      arm.rotation.set(0.2, side * 0.22, side * -0.25);
      this.firstPersonHands.add(arm);
      if (side > 0) this.firstPersonRightArm = arm;
    }
    this.firstPersonHands.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.renderOrder = 10000;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.depthTest = false;
        material.depthWrite = false;
        material.transparent = true;
        material.opacity = 1;
      }
    });
    this.firstPersonHands.visible = false;
    office.camera.add(this.firstPersonHands);
    addEventListener("keydown", (event) => {
      if ((event.key === "Alt" || event.key === "Control") && this.firstPerson) {
        event.preventDefault();
        if (document.pointerLockElement === this.office.renderer.domElement) {
          this.relockAfterAlt = true;
          this.altUsedOnUI = false;
          this.altPointerOverUI = false;
          document.exitPointerLock();
        }
        return;
      }
      if (this.pointerLockBlocked()) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(target?.tagName) || target?.isContentEditable) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat && this.jumpHeight === 0 && !this.seated) this.jumpVelocity = 4.8;
      }
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "shift"].includes(key)) this.keys.add(key);
    });
    addEventListener("keyup", (event) => {
      if (event.key === "Alt" || event.key === "Control") {
        if (this.relockAfterAlt && !this.altUsedOnUI && !this.altPointerOverUI && this.firstPerson && !this.pointerLockBlocked()) {
          try { void Promise.resolve(this.office.renderer.domElement.requestPointerLock()).catch(() => undefined); } catch {}
        }
        this.relockAfterAlt = false;
        this.altUsedOnUI = false;
        this.altPointerOverUI = false;
        return;
      }
      this.keys.delete(event.key.toLowerCase());
    });
    addEventListener("blur", () => { this.keys.clear(); this.relockAfterAlt = false; this.altUsedOnUI = false; this.altPointerOverUI = false; });
    addEventListener("pointerdown", (event) => {
      if (this.relockAfterAlt && event.target instanceof Element && event.target.closest("#toolbar, #hire, #boss-computer, #board, #terminal, .office-settings-panel, button, input, select, textarea, a, label, [role]")) this.altUsedOnUI = true;
    }, true);
    addEventListener("pointermove", (event) => {
      if (this.relockAfterAlt) this.altPointerOverUI = event.target instanceof Element && !!event.target.closest(".panel, #toolbar, #gate, .desktop-window, .office-settings-panel, button, input, select, textarea, a, label, [role]");
    }, true);
    const canvas = office.renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.lookEnabled || this.pointerLockBlocked() || event.ctrlKey || (this.firstPerson && event.altKey)) return;
      if (this.firstPerson) {
        if (event.button === 0 && document.pointerLockElement !== canvas) {
          try { void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined); } catch {}
          return;
        }
        if (document.pointerLockElement === canvas || event.button !== 2) return;
      }
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      this.dragging = true;
      this.rightLooking = event.button === 2;
      canvas.setPointerCapture(event.pointerId);
    });
    const releaseLook = () => { this.dragging = false; this.rightLooking = false; };
    canvas.addEventListener("pointerup", releaseLook);
    canvas.addEventListener("pointercancel", releaseLook);
    canvas.addEventListener("lostpointercapture", releaseLook);
    canvas.addEventListener("pointermove", (event) => {
      if (!this.dragging || !this.lookEnabled || (this.firstPerson && document.pointerLockElement === canvas)) return;
      this.turnCamera(event.movementX, event.movementY);
    });
    addEventListener("mousemove", (event) => {
      if (!this.firstPerson || document.pointerLockElement !== canvas || !this.lookEnabled || this.pointerLockBlocked()) return;
      this.turnCamera(event.movementX, event.movementY);
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
      if (!this.lookEnabled || this.pointerLockBlocked()) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? innerHeight : 1);
      this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(delta * 0.001), 1.5, 9.5);
    }, { passive: false });
  }

  setFirstPerson(enabled: boolean): void {
    this.firstPerson = enabled;
    this.figure.root.visible = !enabled;
    this.firstPersonHands.visible = enabled;
    document.body.classList.toggle("first-person", enabled);
    if (!enabled && document.pointerLockElement === this.office.renderer.domElement) document.exitPointerLock();
    if (enabled) {
      this.yaw = this.facing - Math.PI;
      this.pitch = 0;
    }
  }

  setXRMode(enabled: boolean): void {
    if (enabled === this.xrMode) return;
    if (enabled) {
      if (this.seated) this.stand();
      this.xrSavedView = { firstPerson: this.firstPerson, yaw: this.yaw, pitch: this.pitch, zoom: this.zoom };
      this.xrMode = true;
      this.keys.clear();
      if (document.pointerLockElement === this.office.renderer.domElement) document.exitPointerLock();
      this.setFirstPerson(true);
      this.firstPersonHands.visible = false;
      this.xrMoveYaw = this.yaw;
      this.office.cameraRig.position.set(this.x, this.groundY, this.z);
      this.office.cameraRig.rotation.set(0, this.yaw, 0);
      this.office.camera.position.set(0, 0, 0);
      this.office.camera.rotation.set(0, 0, 0);
      return;
    }
    const saved = this.xrSavedView;
    this.xrMode = false;
    this.xrForward = this.xrStrafe = 0;
    this.keys.clear();
    this.setFirstPerson(saved?.firstPerson ?? false);
    if (saved) { this.yaw = saved.yaw; this.pitch = saved.pitch; this.zoom = saved.zoom; }
    this.office.cameraRig.position.set(0, 0, 0);
    this.office.cameraRig.rotation.set(0, 0, 0);
    this.xrSavedView = undefined;
  }

  setXRMoveInput(forward: number, strafe: number, yaw: number): void { this.xrForward = forward; this.xrStrafe = strafe; this.xrMoveYaw = yaw; }
  snapTurn(angle: number): void { this.yaw += angle; this.facing = this.yaw + Math.PI; }

  reach(): void { this.reachTimer = 0; }

  private pointerLockBlocked(): boolean {
    const body = document.body;
    const hireMenu = document.getElementById("hire");
    return this.transportLocked || body.classList.contains("terminal-open") || body.classList.contains("boss-computer-open") || body.classList.contains("settings-open") || body.classList.contains("phone-open") || !!document.querySelector("dialog[open]") || !!hireMenu?.getClientRects().length;
  }

  private turnCamera(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.005, this.firstPerson ? -0.65 : -0.2, 1.15);
    if (this.rightLooking || this.firstPerson) this.facing = this.yaw + Math.PI;
  }

  get moving(): boolean {
    return (this.xrMode && Math.hypot(this.xrForward, this.xrStrafe) > 0.12) || this.keys.has("w") || this.keys.has("s") || this.keys.has("a") || this.keys.has("d");
  }

  get worldY(): number { return this.groundY + this.jumpHeight; }

  setTransportLocked(locked: boolean): void { this.transportLocked = locked; this.keys.clear(); }
  setVehiclePose(pose: VehiclePose | null): void {
    if (pose) {
      if (!this.vehiclePose) { this.vehicleCameraReady = false; if (document.pointerLockElement === this.office.renderer.domElement) document.exitPointerLock(); }
      if (this.vehiclePose) Object.assign(this.vehiclePose, pose); else this.vehiclePose = { ...pose };
      this.transportLocked = true; this.seated = false; this.keys.clear(); this.jumpHeight = this.jumpVelocity = 0; this.figure.root.visible = false; this.firstPersonHands.visible = false;
      this.x = pose.x; this.z = pose.z; this.groundY = this.seatGroundY = -3.6; this.facing = pose.yaw;
    } else { this.vehiclePose = null; this.vehicleCameraReady = false; this.transportLocked = false; this.figure.root.visible = !this.firstPerson; this.firstPersonHands.visible = this.firstPerson && !this.xrMode; this.keys.clear(); }
  }

  setTransportHeight(groundY: number): void {
    this.groundY = groundY;
    this.seatGroundY = groundY;
    this.figure.root.position.set(this.x, this.worldY, this.z);
    if (this.xrMode) this.office.cameraRig.position.set(this.x, groundY, this.z);
    else if (this.firstPerson) this.office.camera.position.set(this.x, groundY + 1.31 + this.jumpHeight, this.z);
  }

  teleport(x: number, z: number, groundY: number, yaw = this.yaw): void {
    this.x = x;
    this.z = z;
    this.groundY = groundY;
    this.seatGroundY = groundY;
    this.jumpHeight = 0;
    this.jumpVelocity = 0;
    this.seated = false;
    this.yaw = yaw;
    this.facing = yaw + Math.PI;
    this.figure.root.position.set(x, groundY, z);
    this.figure.root.rotation.y = this.facing;
    if (this.xrMode) {
      this.office.cameraRig.position.set(x, groundY, z);
      this.office.cameraRig.rotation.set(0, yaw, 0);
      this.office.camera.position.set(0, 0, 0);
      this.office.camera.rotation.set(0, 0, 0);
    } else if (this.firstPerson) {
      this.office.camera.position.set(x, groundY + 1.31, z);
      this.office.camera.rotation.order = "YXZ";
      this.office.camera.rotation.set(-this.pitch, yaw, 0);
    }
    this.keys.clear();
  }

  sit(seat: { x: number; z: number; yaw: number; y?: number }): void {
    this.x = seat.x;
    this.z = seat.z;
    this.facing = seat.yaw;
    this.seated = true;
    this.groundY = seat.y ?? this.office.walkSurfaceAt(seat.x, seat.z, this.groundY);
    this.seatGroundY = this.groundY;
    this.jumpHeight = 0;
    this.jumpVelocity = 0;
    this.keys.clear();
  }

  stand(): void {
    if (!this.seated) return;
    this.seated = false;
    this.groundY = this.seatGroundY;
    this.jumpHeight = 0;
    this.jumpVelocity = 0;
    this.keys.clear();
    const position = this.findSafePosition(this.x, this.z);
    this.x = position.x;
    this.z = position.z;
  }

  resetToSafePosition(): void {
    this.seated = false;
    this.groundY = 0;
    this.seatGroundY = 0;
    this.jumpHeight = 0;
    this.jumpVelocity = 0;
    this.keys.clear();
    const position = this.findSafePosition(0, 6.2);
    this.x = position.x;
    this.z = position.z;
    this.facing = Math.PI;
  }

  private findSafePosition(originX: number, originZ: number): { x: number; z: number } {
    const { width, depth } = this.office.options;
    const maxRadius = Math.max(width, depth);
    for (let radius = 0; radius <= maxRadius; radius += 0.35) {
      const steps = radius === 0 ? 1 : Math.max(8, Math.ceil(Math.PI * 2 * radius / 0.35));
      for (let i = 0; i < steps; i++) {
        const angle = i / steps * Math.PI * 2;
        const x = THREE.MathUtils.clamp(originX + Math.sin(angle) * radius, -width / 2 + RADIUS + 0.1, width / 2 - RADIUS - 0.1);
        const z = THREE.MathUtils.clamp(originZ + Math.cos(angle) * radius, -depth / 2 + RADIUS + 0.1, depth / 2 - RADIUS - 0.1);
        if (!this.isBlockedAt(x, z, 0)) return { x, z };
      }
    }
    return { x: 0, z: 6.2 };
  }

  update(dt: number, time: number): void {
    if (this.vehiclePose) {
      const pose = this.vehiclePose, sin = Math.sin(pose.yaw), cos = Math.cos(pose.yaw);
      this.vehicleCameraPosition.set(pose.x - sin * 5.5, -1.15, pose.z - cos * 5.5); this.vehicleCameraTarget.set(pose.x + sin * 2, -2.65, pose.z + cos * 2);
      if (this.vehicleCameraReady) this.office.camera.position.lerp(this.vehicleCameraPosition, 1 - Math.exp(-dt * 10)); else { this.office.camera.position.copy(this.vehicleCameraPosition); this.vehicleCameraReady = true; }
      this.office.camera.lookAt(this.vehicleCameraTarget); this.figure.root.position.set(this.x, this.groundY, this.z); return;
    }
    if (this.reachTimer >= 0) {
      this.reachTimer += dt;
      const reach = Math.sin(Math.min(1, this.reachTimer / 0.42) * Math.PI);
      this.firstPersonRightArm.position.z = -0.44 - reach * 0.36;
      this.firstPersonRightArm.rotation.x = 0.2 - reach * 0.4;
      if (this.reachTimer >= 0.42) { this.reachTimer = -1; this.firstPersonRightArm.position.z = -0.44; this.firstPersonRightArm.rotation.x = 0.2; }
    }
    if (this.pointerLockBlocked()) {
      this.keys.clear();
      if (document.pointerLockElement === this.office.renderer.domElement) document.exitPointerLock();
    }
    if (!this.lookEnabled && document.pointerLockElement === this.office.renderer.domElement) document.exitPointerLock();
    if (this.seated) {
      this.keys.clear();
      this.figure.root.position.set(this.x, this.seatGroundY + 0.28, this.z);
      this.figure.root.rotation.y = this.facing;
      setSitting(this.figure, 1, time);
    } else {
      const forward = this.xrMode ? this.xrForward : (this.keys.has("w") ? 1 : 0) - (this.keys.has("s") ? 1 : 0);
      const strafe = this.xrMode ? this.xrStrafe : (this.keys.has("d") ? 1 : 0) - (this.keys.has("a") ? 1 : 0);
      const movementYaw = this.xrMode ? this.xrMoveYaw : this.yaw;
      const speed = this.xrMode ? VR_WALK : this.keys.has("shift") ? RUN : WALK;
      if (forward || strafe) {
        const length = Math.hypot(forward, strafe) || 1;
        const dx = (-Math.sin(movementYaw) * forward + Math.cos(movementYaw) * strafe) / length;
        const dz = (-Math.cos(movementYaw) * forward - Math.sin(movementYaw) * strafe) / length;
        this.step(dx * speed * dt, dz * speed * dt, this.worldY);
        this.facing = this.xrMode ? this.xrMoveYaw + Math.PI : Math.atan2(dx, dz);
        this.phase += dt;
      }
      const airborne = this.jumpVelocity !== 0 || this.jumpHeight !== 0, surface = this.office.walkSurfaceAt(this.x, this.z, airborne ? this.worldY : this.groundY);
      if (!airborne && Math.abs(surface - this.groundY) <= 0.27) this.groundY = surface;
      if (airborne) {
        const previousY = this.worldY;
        const nextHeight = this.jumpHeight + this.jumpVelocity * dt;
        const nextY = this.groundY + nextHeight;
        if (this.jumpVelocity < 0 && surface >= this.groundY - 0.001 && surface <= previousY && surface >= nextY) {
          this.groundY = surface;
          this.jumpHeight = 0;
          this.jumpVelocity = 0;
        } else if (nextHeight <= 0) {
          this.groundY = surface;
          this.jumpHeight = 0;
          this.jumpVelocity = 0;
        } else {
          this.jumpHeight = nextHeight;
          this.jumpVelocity -= 12 * dt;
        }
      } else if (surface < this.groundY - 0.03) {
        this.jumpHeight = this.groundY - surface;
        this.groundY = surface;
      }
      let turn = this.facing - this.figure.root.rotation.y;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      this.figure.root.rotation.y += turn * Math.min(1, 12 * dt);
      this.figure.root.position.set(this.x, this.worldY, this.z);
      setWalking(this.figure, this.phase, this.moving, time);
    }

    if (this.firstPerson) {
      if (this.xrMode) {
        this.office.cameraRig.position.set(this.x, this.groundY, this.z);
        this.office.cameraRig.rotation.set(0, this.yaw, 0);
        this.office.camera.position.set(0, 0, 0);
        this.office.camera.rotation.order = "YXZ";
        this.office.camera.rotation.set(0, 0, 0);
        return;
      }
      const bob = this.moving && !this.seated ? Math.sin(this.phase * 12) * 0.018 : 0;
      const eyeHeight = this.seated ? 1.34 : 1.31;
      this.office.camera.position.set(this.x, eyeHeight + this.worldY + bob, this.z);
      this.office.camera.rotation.order = "YXZ";
      this.office.camera.rotation.set(-this.pitch, this.yaw, 0);
      return;
    }

    const { width, depth, wallHeight } = this.office.options;
    const target = new THREE.Vector3(this.x, 1.25 + (this.seated ? this.seatGroundY : this.worldY), this.z);
    const direction = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const limits = { x: width / 2 - 0.7, z: depth / 2 - 0.7, low: 0.45, high: wallHeight - 0.35 };
    let distance = this.zoom;
    if (direction.x > 0.001) distance = Math.min(distance, (limits.x - target.x) / direction.x - 0.12);
    if (direction.x < -0.001) distance = Math.min(distance, (-limits.x - target.x) / direction.x - 0.12);
    if (direction.z > 0.001) distance = Math.min(distance, (limits.z - target.z) / direction.z - 0.12);
    if (direction.z < -0.001) distance = Math.min(distance, (-limits.z - target.z) / direction.z - 0.12);
    if (direction.y > 0.001) distance = Math.min(distance, (limits.high - target.y) / direction.y - 0.12);
    if (direction.y < -0.001) distance = Math.min(distance, (limits.low - target.y) / direction.y - 0.12);
    const ray = new THREE.Ray(target, direction);
    const bounds = new THREE.Box3();
    const hit = new THREE.Vector3();
    for (const box of this.office.tallColliders) {
      bounds.copy(box).expandByScalar(0.16);
      if (bounds.containsPoint(target)) continue;
      if (ray.intersectBox(bounds, hit)) distance = Math.min(distance, hit.distanceTo(target) - 0.18);
    }
    this.office.camera.position.copy(target).addScaledVector(direction, Math.max(0.15, distance));
    this.office.camera.position.x = THREE.MathUtils.clamp(this.office.camera.position.x, -limits.x, limits.x);
    this.office.camera.position.y = THREE.MathUtils.clamp(this.office.camera.position.y, limits.low, limits.high);
    this.office.camera.position.z = THREE.MathUtils.clamp(this.office.camera.position.z, -limits.z, limits.z);
    this.office.camera.lookAt(target);
  }

  private step(dx: number, dz: number, feetY: number): void {
    const subdivisions = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.12));
    const stepX = dx / subdivisions, stepZ = dz / subdivisions;
    for (let i = 0; i < subdivisions; i++) {
      const followsSurface = this.jumpHeight === 0 && this.jumpVelocity === 0;
      const nextX = this.x + stepX, xSurface = this.office.walkSurfaceAt(nextX, this.z, this.groundY);
      const xGround = followsSurface && Math.abs(xSurface - this.groundY) <= 0.27 ? xSurface : this.groundY;
      const xStepGround = followsSurface && xGround >= this.groundY - 0.001 ? Math.max(xGround, this.stepUpSurfaceAt(nextX, this.z, this.groundY)) : xGround;
      if (this.office.isWithinWorldBounds(nextX, this.z) && !this.blocked(nextX, this.z, followsSurface ? xStepGround : feetY)) { this.x = nextX; if (followsSurface) this.groundY = xStepGround; }
      const nextZ = this.z + stepZ, zSurface = this.office.walkSurfaceAt(this.x, nextZ, this.groundY);
      const zGround = followsSurface && Math.abs(zSurface - this.groundY) <= 0.27 ? zSurface : this.groundY;
      const zStepGround = followsSurface && zGround >= this.groundY - 0.001 ? Math.max(zGround, this.stepUpSurfaceAt(this.x, nextZ, this.groundY)) : zGround;
      if (this.office.isWithinWorldBounds(this.x, nextZ) && !this.blocked(this.x, nextZ, followsSurface ? zStepGround : feetY)) { this.z = nextZ; if (followsSurface) this.groundY = zStepGround; }
    }
  }

  private stepUpSurfaceAt(x: number, z: number, feetY: number): number {
    let height = feetY;
    for (const box of this.office.colliders) {
      const rise = box.max.y - feetY;
      if (rise <= 0.001 || rise > 0.27 || this.overlapDepth(box, x, z, feetY) <= this.overlapDepth(box, this.x, this.z, feetY) + 0.0001) continue;
      height = Math.max(height, box.max.y);
    }
    return height;
  }

  private blocked(x: number, z: number, feetY: number): boolean {
    return this.office.colliders.some((box) => this.overlapDepth(box, x, z, feetY) > this.overlapDepth(box, this.x, this.z, feetY) + 0.0001);
  }

  private isBlockedAt(x: number, z: number, feetY: number): boolean {
    return this.office.colliders.some((box) => this.overlapDepth(box, x, z, feetY) > 0.0001);
  }

  private overlapDepth(box: THREE.Box3, x: number, z: number, feetY: number): number {
    if (feetY >= box.max.y - 0.01 || feetY + 1.5 <= box.min.y) return 0;
    if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) {
      return RADIUS + Math.min(x - box.min.x, box.max.x - x, z - box.min.z, box.max.z - z);
    }
    const nearestX = Math.max(box.min.x, Math.min(x, box.max.x));
    const nearestZ = Math.max(box.min.z, Math.min(z, box.max.z));
    return Math.max(0, RADIUS - Math.hypot(x - nearestX, z - nearestZ));
  }

}

interface Remote {
  figure: Figure;
  target: THREE.Vector3;
  yawTarget: number;
  phase: number;
  seated: boolean;
  plate: HTMLElement;
}

export class RemoteAvatars {
  private figures = new Map<string, Remote>();
  private projected = new THREE.Vector3();
  private nameplatesVisible = true;

  constructor(private office: Office) {}

  setNameplatesVisible(visible: boolean): void {
    this.nameplatesVisible = visible;
    for (const remote of this.figures.values()) remote.plate.style.display = visible ? "block" : "none";
  }

  sync(list: { connectionId: string; displayName: string; color: string; x: number; y: number; z: number; yaw: number; seated: boolean }[], selfId: string): void {
    const seen = new Set<string>();
    for (const entry of list) {
      if (entry.connectionId === selfId) continue;
      seen.add(entry.connectionId);
      let remote = this.figures.get(entry.connectionId);
      if (!remote) {
        const figure = buildHuman(parseInt(entry.color.replace("#", ""), 16));
        figure.root.position.set(entry.x, entry.y, entry.z);
        figure.root.rotation.y = entry.yaw;
        this.office.scene.add(figure.root);
        const plate = document.createElement("div");
        plate.className = "nameplate";
        document.body.appendChild(plate);
        remote = { figure, target: new THREE.Vector3(entry.x, entry.y, entry.z), yawTarget: entry.yaw, phase: 0, seated: entry.seated, plate };
        this.figures.set(entry.connectionId, remote);
      }
      remote.plate.textContent = entry.displayName;
      remote.target.set(entry.x, entry.y, entry.z);
      remote.yawTarget = entry.yaw;
      remote.seated = entry.seated;
    }
    for (const [id, remote] of this.figures) {
      if (seen.has(id)) continue;
      this.office.scene.remove(remote.figure.root);
      remote.plate.remove();
      this.figures.delete(id);
    }
  }

  move(connectionId: string, x: number, y: number, z: number, yaw: number, seated: boolean): void {
    const remote = this.figures.get(connectionId);
    if (!remote) return;
    remote.target.set(x, y, z);
    remote.yawTarget = yaw;
    remote.seated = seated;
  }

  update(dt: number, time: number): void {
    for (const remote of this.figures.values()) {
      const distance = Math.hypot(remote.target.x - remote.figure.root.position.x, remote.target.z - remote.figure.root.position.z);
      const walking = distance > 0.05;
      if (walking) remote.phase += dt;
      remote.figure.root.position.lerp(remote.target, Math.min(1, 9 * dt));
      let turn = remote.yawTarget - remote.figure.root.rotation.y;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      remote.figure.root.rotation.y += turn * Math.min(1, 8 * dt);
      if (remote.seated) {
        remote.figure.root.position.y = remote.target.y + 0.28;
        setSitting(remote.figure, 1, time);
      } else setWalking(remote.figure, remote.phase, walking, time);
      this.projected.set(remote.figure.root.position.x, remote.figure.root.position.y + (remote.seated ? 1.4 : 1.53), remote.figure.root.position.z).project(this.office.camera);
      const visible = this.nameplatesVisible && this.projected.z >= -1 && this.projected.z <= 1 && Math.abs(this.projected.x) < 1 && Math.abs(this.projected.y) < 1;
      remote.plate.style.display = visible ? "block" : "none";
      if (visible) {
        remote.plate.style.left = `${(this.projected.x + 1) * innerWidth / 2}px`;
        remote.plate.style.top = `${(1 - this.projected.y) * innerHeight / 2}px`;
      }
    }
  }
}
