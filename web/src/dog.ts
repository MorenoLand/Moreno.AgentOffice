import * as THREE from "three";

export class OfficeDog {
  readonly root = new THREE.Group();
  readonly name = "Milo";
  readonly bedPosition = new THREE.Vector3(6.8, 0, -6.3);
  private tail = new THREE.Group();
  private head = new THREE.Group();
  private body: THREE.Mesh;
  private legs: THREE.Mesh[] = [];
  private paws: THREE.Mesh[] = [];
  private petUntil = 0;
  private phase = 0;
  private target = new THREE.Vector3(7.7, 0, -6.3);
  private nextWander = 4;
  private nextRest = 28;
  private restUntil = 0;
  private restWanted = false;
  private commandedRest = false;
  private restingAmount = 0;

  constructor(scene: THREE.Scene) {
    const fur = new THREE.MeshStandardMaterial({ color: 0xb38159, roughness: 0.92 }), cream = new THREE.MeshStandardMaterial({ color: 0xf1dfbf, roughness: 0.9 }), dark = new THREE.MeshStandardMaterial({ color: 0x493c37, roughness: 0.48 }), eyes = new THREE.MeshStandardMaterial({ color: 0x211c18, roughness: 0.17 }), earSkin = new THREE.MeshStandardMaterial({ color: 0x96674f, roughness: 0.88 }), claws = new THREE.MeshStandardMaterial({ color: 0xb9aa94, roughness: 0.78 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.58, 8, 24).rotateX(Math.PI / 2), fur);
    body.scale.set(1.1, 0.72, 1);
    body.position.set(0, 0.48, -0.06);
    body.castShadow = true;
    this.body = body;
    this.root.add(body);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.265, 24, 16), cream);
    chest.position.set(0, -0.015, 0.36);
    chest.scale.set(0.88, 1.14, 0.81);
    chest.castShadow = true;
    body.add(chest);
    for (const side of [-1, 1]) { const hip = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 14), fur); hip.position.set(side * 0.12, -0.05, -0.3); hip.scale.set(0.72, 1.05, 1.02); hip.castShadow = true; body.add(hip); }
    this.head.position.set(0, 0.62, 0.55);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.275, 28, 20), fur);
    skull.scale.set(0.96, 0.91, 0.98);
    skull.castShadow = true;
    this.head.add(skull);
    const muzzle = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.095, 8, 20).rotateX(Math.PI / 2), cream);
    muzzle.position.set(0, -0.09, 0.235);
    muzzle.scale.set(1.08, 0.75, 1);
    this.head.add(muzzle);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.065, 20, 14), dark);
    nose.position.set(0, -0.056, 0.397); nose.scale.set(1.05, 0.72, 0.68);
    this.head.add(nose);
    const mouth = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.09, -0.123, 0.354), new THREE.Vector3(0, -0.147, 0.376), new THREE.Vector3(0.09, -0.123, 0.354)]), 12, 0.005, 6, false), dark); this.head.add(mouth);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 12), eyes);
      eye.position.set(side * 0.127, 0.024, 0.231);
      this.head.add(eye);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff2db }));
      glint.position.set(side * 0.127 - 0.006, 0.031, 0.251); this.head.add(glint);
      const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.18, 8, 18), fur);
      ear.position.set(side * 0.237, -0.089, -0.055);
      ear.scale.set(1.02, 1, 0.58); ear.rotation.x = -0.15;
      ear.rotation.z = side * -0.28;
      this.head.add(ear);
      const innerEar = new THREE.Mesh(new THREE.CapsuleGeometry(0.057, 0.12, 7, 16), earSkin);
      innerEar.position.set(side * 0.237, -0.09, -0.012); innerEar.scale.z = 0.16; innerEar.rotation.x = -0.15; innerEar.rotation.z = side * -0.28; this.head.add(innerEar);
    }
    this.root.add(this.head);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.025, 10, 32), new THREE.MeshStandardMaterial({ color: 0x79aab4, roughness: 0.83 }));
    collar.rotation.x = Math.PI / 2; collar.position.set(0, 0.49, 0.43); this.root.add(collar);
    const tag = new THREE.Mesh(new THREE.SphereGeometry(0.055, 20, 14), new THREE.MeshStandardMaterial({ color: 0xe9bb68, roughness: 0.3, metalness: 0.72 }));
    tag.scale.set(0.78, 1.15, 0.3); tag.position.set(0, 0.39, 0.65); this.root.add(tag);
    for (const x of [-0.2, 0.2]) for (const z of [-0.38, 0.35]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(z > 0 ? 0.073 : 0.083, 0.23, 7, 16), fur);
      leg.position.set(x, 0.21, z);
      leg.castShadow = true;
      this.root.add(leg);
      this.legs.push(leg);
      const paw = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), cream);
      paw.position.set(x, 0.07, z + 0.04);
      paw.scale.set(1.12, 0.62, 1.3);
      for (const toe of [-1, 0, 1]) {
        const claw = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), claws);
        claw.position.set(toe * 0.04, -0.007, 0.084); claw.scale.set(0.7, 0.6, 1.25); paw.add(claw);
      }
      this.root.add(paw);
      this.paws.push(paw);
    }
    const tailStem = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 7, 16), fur);
    tailStem.rotation.x = -Math.PI / 2;
    tailStem.position.set(0, 0, -0.17);
    this.tail.add(tailStem);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.071, 16, 12), cream);
    tip.position.set(0, 0, -0.38);
    this.tail.add(tip);
    this.tail.position.set(0, 0.52, -0.56);
    this.root.add(this.tail);
    const bedRoot = new THREE.Group();
    const bed = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.8, 0.12, 32), new THREE.MeshStandardMaterial({ color: 0x92b8c3, roughness: 0.94 }));
    bed.position.set(0, 0.06, -0.08);
    bed.receiveShadow = true;
    bedRoot.add(bed);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.075, 12, 40), new THREE.MeshStandardMaterial({ color: 0xc0d8d7, roughness: 0.96 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 0.14, -0.08);
    bedRoot.add(rim);
    const cushion = new THREE.Mesh(new THREE.SphereGeometry(0.59, 28, 18), new THREE.MeshStandardMaterial({ color: 0xe0c2d4, roughness: 0.96 }));
    cushion.scale.y = 0.13;
    cushion.position.set(0, 0.15, -0.08);
    cushion.receiveShadow = true;
    bedRoot.add(cushion);
    bedRoot.position.copy(this.bedPosition);
    this.root.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = object.receiveShadow = true; });
    scene.add(bedRoot);
    this.root.position.copy(this.target);
    scene.add(this.root);
  }

  isNear(x: number, z: number, y = 0): boolean { return Math.abs(y) < 1.25 && Math.hypot(x - this.root.position.x, z - this.root.position.z) < 1.65; }
  pet(x: number, z: number): void { this.root.rotation.y = Math.atan2(x - this.root.position.x, z - this.root.position.z); this.petUntil = this.phase + 2.8; }
  private chooseWanderTarget(): void { const angle = Math.random() * Math.PI * 2, distance = 2.6 + Math.random() * 2.8; this.target.set(THREE.MathUtils.clamp(this.bedPosition.x + Math.cos(angle) * distance, 5, 10.4), 0, THREE.MathUtils.clamp(this.bedPosition.z + Math.sin(angle) * distance, -9.4, -1.4)); }
  commandRest(): boolean {
    if (this.restWanted) {
      this.restWanted = this.commandedRest = false;
      this.nextRest = this.phase + 25 + Math.random() * 20;
      this.chooseWanderTarget();
      this.nextWander = this.phase + 4 + Math.random() * 6;
      return false;
    }
    this.restWanted = this.commandedRest = true;
    this.target.copy(this.bedPosition);
    return true;
  }

  update(dt: number): void {
    this.phase += dt;
    const petting = this.phase < this.petUntil;
    if (!this.restWanted && !petting && this.phase >= this.nextRest) {
      this.restWanted = true;
      this.commandedRest = false;
      this.restUntil = this.phase + 12 + Math.random() * 8;
      this.target.copy(this.bedPosition);
    }
    if (this.restWanted && !this.commandedRest && this.phase >= this.restUntil) {
      this.restWanted = false;
      this.nextRest = this.phase + 30 + Math.random() * 25;
      this.chooseWanderTarget();
      this.nextWander = this.phase + 4 + Math.random() * 6;
    }
    if (!this.restWanted && !petting && this.phase > this.nextWander) {
      this.chooseWanderTarget();
      this.nextWander = this.phase + 4 + Math.random() * 6;
    }
    const dx = this.target.x - this.root.position.x, dz = this.target.z - this.root.position.z, distance = Math.hypot(dx, dz);
    if (!petting && distance > 0.12) {
      const step = Math.min(distance, dt * (this.restWanted ? 0.52 : 0.76));
      this.root.position.x += dx / distance * step;
      this.root.position.z += dz / distance * step;
      this.root.rotation.y = Math.atan2(dx, dz);
    }
    const atBed = Math.hypot(this.root.position.x - this.bedPosition.x, this.root.position.z - this.bedPosition.z) < 0.18;
    this.restingAmount = THREE.MathUtils.damp(this.restingAmount, this.restWanted && atBed ? 1 : 0, 3.5, dt);
    const walking = !petting && distance > 0.12 && this.restingAmount < 0.8;
    this.body.position.y = THREE.MathUtils.lerp(0.48, 0.34, this.restingAmount) + (walking ? Math.abs(Math.sin(this.phase * 16)) * 0.02 : 0);
    this.body.scale.y = 0.72 * (1 + Math.sin(this.phase * 2.1) * THREE.MathUtils.lerp(0.018, 0.04, this.restingAmount));
    this.head.position.y = THREE.MathUtils.lerp(0.62, 0.41, this.restingAmount) + Math.sin(this.phase * 1.2) * 0.015;
    this.head.position.z = THREE.MathUtils.lerp(0.55, 0.48, this.restingAmount);
    for (let i = 0; i < this.legs.length; i++) { const gait = walking ? Math.sin(this.phase * 8 + [0, Math.PI, Math.PI, 0][i]) : 0, front = i % 2 === 1; this.legs[i].position.y = THREE.MathUtils.lerp(0.21, 0.13, this.restingAmount) + Math.max(0, gait) * 0.025; this.legs[i].position.z = (front ? 0.35 : -0.38) + gait * 0.09; this.paws[i].position.y = THREE.MathUtils.lerp(0.07, 0.065, this.restingAmount) + Math.max(0, gait) * 0.018; this.paws[i].position.z = (front ? 0.39 : -0.34) + gait * 0.11; }
    this.tail.rotation.y = Math.sin(this.phase * (petting ? 17 : walking ? 6 : 3.8)) * THREE.MathUtils.lerp(0.14, 0.08, this.restingAmount) * (petting ? 2.4 : 1);
    this.tail.rotation.x = Math.sin(this.phase * 5) * THREE.MathUtils.lerp(0.1, 0.04, this.restingAmount);
    this.tail.rotation.z = Math.sin(this.phase * 5) * 0.08;
  }
}
