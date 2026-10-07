import * as THREE from "three";

export type WeatherKind = "sunny" | "cloudy" | "drizzle" | "rain" | "heavy-rain" | "fog" | "snow";
export type SeasonOption = "auto" | "spring" | "summer" | "autumn" | "winter";
export interface WeatherLighting { daylight: number; direct: number; diffuse: number; sunElevation: number; cloudCover: number; sunDirection: THREE.Vector3; sunColor: THREE.Color; skyColor: THREE.Color; calendar: Date; season: Exclude<SeasonOption, "auto"> }
const WEATHER_KINDS: WeatherKind[] = ["sunny", "cloudy", "drizzle", "rain", "heavy-rain", "fog", "snow"];
const SEASON_WEIGHTS: Record<Exclude<SeasonOption, "auto">, number[]> = {
  winter: [0.28, 0.25, 0.06, 0.12, 0.03, 0.06, 0.20],
  spring: [0.35, 0.23, 0.16, 0.16, 0.04, 0.06, 0],
  summer: [0.52, 0.16, 0.10, 0.12, 0.07, 0.03, 0],
  autumn: [0.32, 0.24, 0.10, 0.22, 0.03, 0.09, 0],
};

export class WeatherSystem {
  private readonly sun: THREE.DirectionalLight;
  private readonly rain: THREE.LineSegments;
  private readonly snow: THREE.Points;
  private readonly windowRain: THREE.LineSegments;
  private readonly clouds: THREE.Group | undefined;
  private readonly skyDay = new THREE.Color(0x87bddd);
  private readonly skyNight = new THREE.Color(0x030711);
  private readonly cloudDay = new THREE.Color(0xf6f6f0);
  private readonly cloudShade = new THREE.Color(0x747f8b);
  private readonly skyCanvas = document.createElement("canvas");
  private readonly skyTexture: THREE.CanvasTexture;
  private readonly skyContext: CanvasRenderingContext2D;
  private readonly skyDome: THREE.Mesh;
  private fogNear?: number;
  private fogFar?: number;
  private elapsed = 0;
  isNight = false;
  readonly lighting: WeatherLighting = { daylight: 0, direct: 0, diffuse: 0, sunElevation: 0, cloudCover: 0, sunDirection: new THREE.Vector3(), sunColor: new THREE.Color(0xfff2dd), skyColor: new THREE.Color(), calendar: new Date(), season: "autumn" };
  private weatherAge = 0;
  private weatherDuration = 120 + Math.random() * 180;
  private skyAge = 1;
  private weatherIndex = 0;
  private seasonOption: SeasonOption = "auto";
  private windX = 0.15;
  private windZ = 0.04;
  private viewerX = 0;
  private viewerZ = 0;
  private readonly precipitationRadius = 32;
  get windStrength(): number { return Math.min(1, Math.hypot(this.windX, this.windZ) / 1.6); }
  private readonly rainCapacity = 1200;
  private readonly windowRainCapacity = 192;
  private rainDrops: Float32Array;
  private snowFlakes: Float32Array;
  private windowDrops: Float32Array;
  private cloudMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.72, depthWrite: false });
  get current(): WeatherKind { return WEATHER_KINDS[this.weatherIndex]; }
  get season(): SeasonOption { return this.seasonOption; }
  get resolvedSeason(): Exclude<SeasonOption, "auto"> { return this.seasonOption === "auto" ? (["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"] as const)[this.lighting.calendar.getMonth()] : this.seasonOption; }
  get daylight(): number { return this.lighting.daylight; }

  setSeason(season: SeasonOption): void {
    if (season === this.seasonOption) return;
    this.seasonOption = season;
    this.chooseWeather();
    this.weatherAge = 0;
  }

  constructor(private scene: THREE.Scene, depth: number, private readonly shelters: readonly THREE.Box3[] = []) {
    if (scene.fog instanceof THREE.Fog) { this.fogNear = scene.fog.near; this.fogFar = scene.fog.far; }
    this.skyCanvas.width = 512;
    this.skyCanvas.height = 256;
    this.skyContext = this.skyCanvas.getContext("2d")!;
    this.skyTexture = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTexture.colorSpace = THREE.SRGBColorSpace;
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(160, 32, 20), new THREE.MeshBasicMaterial({ map: this.skyTexture, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.skyDome.renderOrder = -1;
    this.skyDome.frustumCulled = false;
    scene.add(this.skyDome);
    this.drawSky(0, 0.1);
    this.clouds = scene.getObjectByName("outdoor-clouds") as THREE.Group | undefined;
    const cloudGroup = this.clouds;
    if (cloudGroup) cloudGroup.traverse((object) => { if ((object as THREE.Mesh).material) (object as THREE.Mesh).material = this.cloudMaterial; });
    this.sun = new THREE.DirectionalLight(0xfff2d5, 0);
    this.sun.position.set(-28, 30, -36);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 150 });
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2;
    scene.add(this.sun, this.sun.target);
    this.rainDrops = new Float32Array(this.rainCapacity * 6);
    this.snowFlakes = new Float32Array(360 * 3);
    this.windowDrops = new Float32Array(this.windowRainCapacity * 4 * 3);
    this.rain = this.lines(this.rainDrops, 0x9ac6e0, 0.48);
    this.snow = this.points(this.snowFlakes, 0xf6fbff, 0.12);
    this.windowRain = this.lines(this.windowDrops, 0xb7d3e5, 0.38);
    this.rain.renderOrder = -1;
    this.windowRain.position.z = -depth / 2 - 0.65;
    scene.add(this.rain, this.snow, this.windowRain);
    this.seedRain();
    this.seedSnow();
    this.seedWindowRain();
    this.chooseWeather();
    this.update(0);
  }

  update(dt: number, viewerX = this.viewerX, viewerZ = this.viewerZ): void {
    this.viewerX = viewerX; this.viewerZ = viewerZ;
    this.elapsed += dt;
    this.weatherAge += dt;
    this.skyAge += dt;
    if (this.weatherAge >= this.weatherDuration) { this.chooseWeather(); this.weatherAge = 0; }
    const kind = this.current;
    const calendar = this.lighting.calendar; calendar.setTime(Date.now());
    const season = this.resolvedSeason;
    const dayOfYear = this.seasonOption === "auto" ? Math.floor((Date.UTC(calendar.getFullYear(), calendar.getMonth(), calendar.getDate()) - Date.UTC(calendar.getFullYear(), 0, 1)) / 86400000) : { spring: 80, summer: 172, autumn: 266, winter: 355 }[season];
    const seasonalAngle = (dayOfYear - 80) / 365.25 * Math.PI * 2;
    const dayLength = 12 + Math.sin(seasonalAngle) * 3, sunrise = 12 - dayLength / 2;
    const hour = calendar.getHours() + calendar.getMinutes() / 60 + calendar.getSeconds() / 3600;
    const sunAngle = (hour - sunrise) / dayLength * Math.PI, altitude = Math.sin(sunAngle) * (0.65 + Math.sin(seasonalAngle) * 0.27);
    const daylight = THREE.MathUtils.smoothstep(altitude, -0.06, 0.08);
    this.isNight = altitude < -0.06;
    const cover = kind === "sunny" ? 0.08 : kind === "cloudy" ? 0.6 : kind === "drizzle" ? 0.7 : kind === "rain" ? 0.84 : kind === "heavy-rain" ? 0.98 : kind === "fog" ? 0.92 : 0.78;
    const skyTint = kind === "snow" ? 0xaebed0 : kind === "fog" ? 0xa9b9be : kind === "heavy-rain" ? 0x64717d : 0x6e7d8c;
    const sky = this.skyNight.clone().lerp(this.skyDay, daylight).lerp(new THREE.Color(skyTint).multiplyScalar(0.02 + daylight * 0.98), cover * 0.52);
    (this.scene.background as THREE.Color).copy(sky);
    if (this.skyAge >= 1) { this.drawSky(daylight, cover); this.skyAge = 0; }
    if (this.scene.fog instanceof THREE.Fog) { this.scene.fog.color.copy(sky); this.scene.fog.near = kind === "fog" ? 6 : kind === "heavy-rain" ? 22 : this.fogNear ?? this.scene.fog.near; this.scene.fog.far = kind === "fog" ? 48 : kind === "heavy-rain" ? 62 : this.fogFar ?? this.scene.fog.far; }
    this.lighting.daylight = daylight; this.lighting.direct = 1.65 * THREE.MathUtils.smoothstep(altitude, 0, 0.22) * (1 - cover * 0.94); this.lighting.diffuse = daylight * (1 - cover * 0.62); this.lighting.sunElevation = Math.asin(THREE.MathUtils.clamp(altitude, -1, 1)); this.lighting.cloudCover = cover; this.lighting.season = season;
    const horizontal = Math.sqrt(1 - altitude * altitude);
    this.lighting.sunDirection.set(Math.cos(sunAngle) * horizontal, altitude, -Math.sin(sunAngle) * horizontal);
    this.lighting.sunColor.set(0xfff2dd).lerp(new THREE.Color(0xffbb80), (1 - THREE.MathUtils.smoothstep(altitude, 0, 0.35)) * (1 - cover));
    this.lighting.skyColor.copy(sky);
    this.sun.position.copy(this.lighting.sunDirection).multiplyScalar(65);
    this.sun.intensity = this.lighting.direct;
    this.sun.visible = this.lighting.direct > 0.015;
    this.sun.color.copy(this.lighting.sunColor);
    this.cloudMaterial.color.copy(this.cloudDay).lerp(this.cloudShade, cover).multiplyScalar(0.08 + daylight * 0.92);
    this.cloudMaterial.opacity = 0.24 + cover * 0.72;
    if (this.clouds) for (const cloud of this.clouds.children) { cloud.position.x += dt * (0.11 + Math.abs(this.windX) * 0.35); if (cloud.position.x > 46) cloud.position.x = -46; }
    const raining = kind === "drizzle" || kind === "rain" || kind === "heavy-rain";
    const rainCount = kind === "drizzle" ? 160 : kind === "rain" ? 520 : kind === "heavy-rain" ? this.rainCapacity : 0;
    const windowRainCount = kind === "drizzle" ? 36 : kind === "rain" ? 104 : kind === "heavy-rain" ? this.windowRainCapacity : 0;
    const rainSpeed = kind === "drizzle" ? 4.5 : kind === "rain" ? 11.5 : kind === "heavy-rain" ? 19 : 0;
    const windowRainSpeed = kind === "drizzle" ? 0.85 : kind === "rain" ? 1.7 : kind === "heavy-rain" ? 3.2 : 0;
    (this.rain.material as THREE.LineBasicMaterial).opacity = kind === "heavy-rain" ? 0.62 : kind === "rain" ? 0.42 : 0.24;
    (this.windowRain.material as THREE.LineBasicMaterial).opacity = kind === "heavy-rain" ? 0.48 : 0.3;
    this.rain.geometry.setDrawRange(0, rainCount * 2);
    this.windowRain.geometry.setDrawRange(0, windowRainCount * 4);
    this.rain.visible = raining;
    this.snow.visible = kind === "snow";
    this.windowRain.visible = raining;
    this.moveRain(dt, rainSpeed, rainCount);
    this.moveSnow(dt, kind === "snow" ? 1.8 : 0);
    this.moveWindowRain(dt, windowRainSpeed, windowRainCount);
  }

  private chooseWeather(): void {
    const season = this.resolvedSeason;
    const weights = [...SEASON_WEIGHTS[season]];
    if (this.current !== "snow" || season === "winter") weights[this.weatherIndex] += 0.25;
    let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0), index = 0;
    for (; index < weights.length - 1; index++) if ((roll -= weights[index]) <= 0) break;
    this.weatherIndex = index;
    this.weatherDuration = this.current === "heavy-rain" ? 300 + Math.random() * 420 : this.current === "fog" ? 90 + Math.random() * 120 : 130 + Math.random() * 220;
    const strength = this.current === "heavy-rain" ? 0.8 + Math.random() * 1.2 : this.current === "rain" ? 0.35 + Math.random() * 0.6 : 0.08 + Math.random() * 0.55;
    this.windX = (Math.random() < 0.5 ? -1 : 1) * strength;
    this.windZ = (Math.random() - 0.5) * strength * 0.5;
  }

  private lines(data: Float32Array, color: number, opacity: number): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    lines.frustumCulled = false;
    return lines;
  }

  private points(data: Float32Array, color: number, size: number): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.82, depthWrite: false }));
    points.frustumCulled = false;
    return points;
  }

  private drawSky(daylight: number, cover: number): void {
    const top = new THREE.Color(0x02040a).lerp(new THREE.Color(0x3c88ad), daylight).lerp(new THREE.Color(0x687582).multiplyScalar(0.02 + daylight * 0.98), cover * 0.56);
    const middle = new THREE.Color(0x040811).lerp(new THREE.Color(0x89bed2), daylight).lerp(new THREE.Color(0x98a2a7).multiplyScalar(0.02 + daylight * 0.98), cover * 0.48);
    const horizon = new THREE.Color(0x080e1a).lerp(new THREE.Color(0xc4d9dc), daylight).lerp(new THREE.Color(0xaeb6b7).multiplyScalar(0.02 + daylight * 0.98), cover * 0.35);
    const gradient = this.skyContext.createLinearGradient(0, 0, 0, this.skyCanvas.height);
    gradient.addColorStop(0, `#${top.getHexString()}`);
    gradient.addColorStop(0.56, `#${middle.getHexString()}`);
    gradient.addColorStop(1, `#${horizon.getHexString()}`);
    this.skyContext.fillStyle = gradient;
    this.skyContext.fillRect(0, 0, this.skyCanvas.width, this.skyCanvas.height);
    this.skyContext.fillStyle = `rgba(255,255,255,${daylight * 0.2})`;
    this.skyContext.beginPath();
    this.skyContext.ellipse(360, 212, 210, 28, 0, 0, Math.PI * 2);
    this.skyContext.fill();
    this.skyTexture.needsUpdate = true;
  }

  private seedRain(): void { for (let i = 0; i < this.rainCapacity; i++) this.setRainDrop(i, Math.random() * 19 - 3.6); }
  private setRainDrop(i: number, y: number): void {
    const n = i * 6, x = this.viewerX + (Math.random() * 2 - 1) * this.precipitationRadius, z = this.viewerZ + (Math.random() * 2 - 1) * this.precipitationRadius, length = 0.34 + Math.random() * 0.38;
    const roof = Math.max(this.shelterHeight(x, z), this.shelterHeight(x - 0.06 - this.windX * 0.035, z + 0.02 + this.windZ * 0.035)); if (y - length < roof) y = roof + length + Math.random() * 12;
    this.rainDrops.set([x, y, z, x - 0.06 - this.windX * 0.035, y - length, z + 0.02 + this.windZ * 0.035], n);
  }
  private wrapPrecipitation(value: number, center: number): number { const span = this.precipitationRadius * 2; return center - this.precipitationRadius + THREE.MathUtils.euclideanModulo(value - center + this.precipitationRadius, span); }
  private shelterHeight(x: number, z: number): number { let height = -Infinity; for (const box of this.shelters) if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) height = Math.max(height, box.max.y); return height; }
  private moveRain(dt: number, speed: number, count: number): void {
    if (!count) return;
    for (let i = 0; i < count; i++) {
      const n = i * 6, y = this.rainDrops[n + 1] - speed * dt;
      if (y < -3.6) this.setRainDrop(i, 17 + Math.random() * 8);
      else {
        const length = this.rainDrops[n + 1] - this.rainDrops[n + 4];
        const x = this.wrapPrecipitation(this.rainDrops[n] + this.windX * dt, this.viewerX), z = this.wrapPrecipitation(this.rainDrops[n + 2] + this.windZ * dt, this.viewerZ);
        if (y - length < Math.max(this.shelterHeight(x, z), this.shelterHeight(x - 0.06 - this.windX * 0.035, z + 0.02 + this.windZ * 0.035))) { this.setRainDrop(i, 17 + Math.random() * 8); continue; }
        this.rainDrops[n] = x; this.rainDrops[n + 1] = y; this.rainDrops[n + 2] = z;
        this.rainDrops[n + 3] = x - 0.06 - this.windX * 0.035; this.rainDrops[n + 4] = y - length; this.rainDrops[n + 5] = z + 0.02 + this.windZ * 0.035;
      }
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private seedSnow(): void { for (let i = 0; i < 360; i++) this.setSnowFlake(i, Math.random() * 20 - 3.6); }
  private setSnowFlake(i: number, y: number): void { const x = this.viewerX + (Math.random() * 2 - 1) * this.precipitationRadius, z = this.viewerZ + (Math.random() * 2 - 1) * this.precipitationRadius, roof = this.shelterHeight(x, z); this.snowFlakes.set([x, y < roof ? roof + Math.random() * 12 : y, z], i * 3); }
  private moveSnow(dt: number, speed: number): void {
    if (!speed) return;
    for (let i = 0; i < 360; i++) {
      const n = i * 3;
      this.snowFlakes[n + 1] -= speed * dt;
      this.snowFlakes[n] = this.wrapPrecipitation(this.snowFlakes[n] + Math.sin(this.elapsed * 0.7 + i) * dt * 0.22 + this.windX * dt * 0.3, this.viewerX);
      this.snowFlakes[n + 2] = this.wrapPrecipitation(this.snowFlakes[n + 2] + this.windZ * dt * 0.3, this.viewerZ);
      const x = this.snowFlakes[n], z = this.snowFlakes[n + 2];
      if (this.snowFlakes[n + 1] < -3.6 || this.snowFlakes[n + 1] < this.shelterHeight(x, z)) this.setSnowFlake(i, 16 + Math.random() * 8);
    }
    (this.snow.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private seedWindowRain(): void { for (let i = 0; i < this.windowRainCapacity; i++) this.setWindowDrop(i, Math.random() * 5.4 + 1); }
  private setWindowDrop(i: number, y: number): void {
    const n = i * 12, x = Math.random() * 27.6 - 13.8;
    this.windowDrops.set([x, y, 0, x - 0.018, y - 0.18, 0, x - 0.018, y - 0.18, 0, x - 0.036, y - 0.36, 0], n);
  }
  private moveWindowRain(dt: number, speed: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const n = i * 12, y = this.windowDrops[n + 1] - speed * dt;
      if (y < 1.05) this.setWindowDrop(i, 6.3 + Math.random() * 0.7);
      else { this.windowDrops[n + 1] = y; this.windowDrops[n + 4] = y - 0.18; this.windowDrops[n + 7] = y - 0.18; this.windowDrops[n + 10] = y - 0.36; }
    }
    (this.windowRain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
