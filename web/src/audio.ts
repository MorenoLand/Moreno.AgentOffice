import type { WeatherKind } from "./weather";

export class OfficeAudio {
  private context?: AudioContext
  private ambienceSource?: AudioBufferSourceNode
  private ambienceGain?: GainNode
  private ambienceFilter?: BiquadFilterNode
  private weatherBus?: GainNode
  private rainSource?: AudioBufferSourceNode
  private rainFilter?: BiquadFilterNode
  private rainGain?: GainNode
  private windSource?: AudioBufferSourceNode
  private windFilter?: BiquadFilterNode
  private windGain?: GainNode
  private weatherKind: WeatherKind = "sunny"
  private weatherWind = 0
  private weatherNight = false
  private weatherIndoors = false
  private weatherEventIn = 2
  private thunderIn = 35
  private rainDripBuffer?: AudioBuffer
  private thunderBuffer?: AudioBuffer
  private footstepBuffer?: AudioBuffer
  private ambienceEnabled = true
  private footstepsEnabled = true
  private walking = false
  private stepTimer?: number
  private disposed = false

  async unlock(): Promise<void> {
    if (this.disposed || typeof window === "undefined" || !window.AudioContext) return
    try {
      this.context ??= new window.AudioContext()
      await this.context.resume()
      this.syncAmbience()
      this.syncWeather()
      this.syncWalking()
    } catch {
      this.stopWalking()
    }
  }

  setWalking(walking: boolean): void {
    this.walking = walking
    this.syncWalking()
  }

  setFootstepsEnabled(enabled: boolean): void {
    this.footstepsEnabled = enabled
    this.syncWalking()
  }

  setAmbienceEnabled(enabled: boolean): void {
    this.ambienceEnabled = enabled
    this.syncAmbience()
    this.syncWeather()
  }

  setWeather(kind: WeatherKind, wind: number, night: boolean, indoors: boolean): void {
    const nextWind = Math.max(0, Math.min(1, wind))
    const changed = kind !== this.weatherKind || night !== this.weatherNight || indoors !== this.weatherIndoors || Math.abs(nextWind - this.weatherWind) >= 0.025
    this.weatherKind = kind
    this.weatherWind = nextWind
    this.weatherNight = night
    this.weatherIndoors = indoors
    if (changed) this.syncWeatherMix()
  }

  updateWeather(dt: number): void {
    if (!this.context || this.context.state !== "running" || !this.weatherBus) return
    this.weatherEventIn -= dt
    if (this.weatherEventIn <= 0) {
      const rainy = this.weatherKind === "drizzle" || this.weatherKind === "rain" || this.weatherKind === "heavy-rain"
      if (rainy && this.weatherIndoors && Math.random() < 0.52) this.playRainDrip()
      else if (this.weatherNight && !rainy && Math.random() < 0.78) this.playWeatherChirp(3900, 4700, 0.075, 0.012)
      else if (!this.weatherNight && (this.weatherKind === "sunny" || this.weatherKind === "cloudy" || this.weatherKind === "fog") && Math.random() < 0.74) this.playWeatherChirp(2200 + Math.random() * 800, 3000 + Math.random() * 900, 0.14, 0.013)
      this.weatherEventIn = (rainy && this.weatherIndoors ? 4.5 : this.weatherNight ? 2.8 : 3.5) + Math.random() * (rainy && this.weatherIndoors ? 5.5 : 4)
    }
    if (this.weatherKind === "heavy-rain") {
      this.thunderIn -= dt
      if (this.thunderIn <= 0) { this.playThunder(); this.thunderIn = 42 + Math.random() * 65; }
    } else this.thunderIn = Math.max(this.thunderIn, 18)
  }

  playDoor(): void {
    const context = this.context;
    if (!context || context.state !== "running" || this.disposed) return;
    const now = context.currentTime;
    try {
      const noise = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      noise.buffer = this.createNoise(context, 0.34, false);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(560, now);
      filter.frequency.exponentialRampToValueAtTime(230, now + 0.28);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.035, now + 0.035);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.31);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
      noise.start(now);
      noise.stop(now + 0.34);
    } catch {}
  }

  playHorn(): void {
    const context = this.context;
    if (!context || context.state !== "running" || this.disposed) return;
    const now = context.currentTime, gain = context.createGain(); gain.gain.setValueAtTime(0.035, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45); gain.connect(context.destination);
    for (const frequency of [349, 440]) { const tone = context.createOscillator(); tone.type = "sawtooth"; tone.frequency.value = frequency; tone.connect(gain); tone.onended = () => { tone.disconnect(); }; tone.start(now); tone.stop(now + 0.45); }
    window.setTimeout(() => gain.disconnect(), 600);
  }
  playCoffee(): void {
    const context = this.context;
    if (!context || context.state !== "running" || this.disposed) return;
    const now = context.currentTime, source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain(); source.buffer = this.createNoise(context, 3.4, false); filter.type = "bandpass"; filter.frequency.value = 700; filter.Q.value = 0.5; gain.gain.setValueAtTime(0.012, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.4); source.connect(filter); filter.connect(gain); gain.connect(context.destination); source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); }; source.start(now); source.stop(now + 3.4);
  }
  playDog(): void {
    const context = this.context;
    if (!context || context.state !== "running" || this.disposed) return;
    try {
      const now = context.currentTime, tone = context.createOscillator(), gain = context.createGain();
      tone.type = "triangle";
      tone.frequency.setValueAtTime(390, now);
      tone.frequency.exponentialRampToValueAtTime(720, now + 0.08);
      tone.frequency.exponentialRampToValueAtTime(470, now + 0.2);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.045, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      tone.connect(gain);
      gain.connect(context.destination);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.start(now);
      tone.stop(now + 0.25);
    } catch {}
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopWalking()
    this.ambienceSource?.stop()
    this.ambienceSource?.disconnect()
    this.ambienceFilter?.disconnect()
    this.ambienceGain?.disconnect()
    this.rainSource?.stop()
    this.rainSource?.disconnect()
    this.rainFilter?.disconnect()
    this.rainGain?.disconnect()
    this.windSource?.stop()
    this.windSource?.disconnect()
    this.windFilter?.disconnect()
    this.windGain?.disconnect()
    this.weatherBus?.disconnect()
    this.ambienceSource = undefined
    this.ambienceFilter = undefined
    this.ambienceGain = undefined
    if (this.context && this.context.state !== "closed") await this.context.close().catch(() => undefined)
    this.context = undefined
  }

  private syncAmbience(): void {
    const context = this.context
    if (!context || context.state === "closed") return
    try {
      if (this.ambienceEnabled && !this.ambienceSource) {
        const source = context.createBufferSource()
        const filter = context.createBiquadFilter()
        const gain = context.createGain()
        source.buffer = this.createNoise(context, 2, true)
        source.loop = true
        filter.type = "lowpass"
        filter.frequency.value = 420
        filter.Q.value = 0.45
        source.connect(filter)
        filter.connect(gain)
        gain.connect(context.destination)
        source.start()
        this.ambienceSource = source
        this.ambienceFilter = filter
        this.ambienceGain = gain
      }
      if (this.ambienceGain) this.ambienceGain.gain.setTargetAtTime(this.ambienceEnabled ? 0.012 : 0, context.currentTime, 0.18)
    } catch {
      this.ambienceSource = undefined
      this.ambienceFilter = undefined
      this.ambienceGain = undefined
    }
  }

  private syncWeather(): void {
    const context = this.context
    if (!context || context.state === "closed") return
    try {
      this.rainDripBuffer ??= this.createNoise(context, 0.12, false)
      this.thunderBuffer ??= this.createNoise(context, 5, true)
      if (!this.weatherBus) {
        const bus = context.createGain()
        const rainSource = context.createBufferSource()
        const rainFilter = context.createBiquadFilter()
        const rainGain = context.createGain()
        const windSource = context.createBufferSource()
        const windFilter = context.createBiquadFilter()
        const windGain = context.createGain()
        bus.gain.value = 0
        bus.connect(context.destination)
        rainSource.buffer = this.createNoise(context, 8, false)
        rainSource.loop = true
        rainFilter.type = "lowpass"
        rainGain.gain.value = 0
        rainSource.connect(rainFilter)
        rainFilter.connect(rainGain)
        rainGain.connect(bus)
        windSource.buffer = this.createNoise(context, 8, true)
        windSource.loop = true
        windFilter.type = "lowpass"
        windGain.gain.value = 0
        windSource.connect(windFilter)
        windFilter.connect(windGain)
        windGain.connect(bus)
        rainSource.start()
        windSource.start()
        this.weatherBus = bus
        this.rainSource = rainSource
        this.rainFilter = rainFilter
        this.rainGain = rainGain
        this.windSource = windSource
        this.windFilter = windFilter
        this.windGain = windGain
      }
      this.syncWeatherMix()
    } catch {
      this.weatherBus = undefined
      this.rainSource = undefined
      this.windSource = undefined
    }
  }

  private syncWeatherMix(): void {
    const context = this.context
    if (!context || !this.weatherBus || !this.rainFilter || !this.rainGain || !this.windFilter || !this.windGain) return
    const now = context.currentTime
    const rainy = this.weatherKind === "drizzle" || this.weatherKind === "rain" || this.weatherKind === "heavy-rain"
    const rainLevel = this.weatherKind === "drizzle" ? 0.075 : this.weatherKind === "rain" ? 0.15 : this.weatherKind === "heavy-rain" ? 0.24 : 0
    const windBase = this.weatherKind === "heavy-rain" ? 0.055 : this.weatherKind === "snow" ? 0.046 : this.weatherKind === "rain" ? 0.035 : this.weatherKind === "drizzle" ? 0.022 : this.weatherKind === "cloudy" || this.weatherKind === "fog" ? 0.027 : 0.008
    const rainScale = this.weatherIndoors ? 0.18 : 1, windScale = this.weatherIndoors ? 0.28 : 1
    this.weatherBus.gain.setTargetAtTime(this.ambienceEnabled ? 0.56 : 0, now, 0.45)
    this.rainFilter.frequency.setTargetAtTime(this.weatherIndoors ? 850 : 6200, now, 0.9)
    this.rainFilter.Q.setTargetAtTime(this.weatherIndoors ? 0.45 : 0.2, now, 0.9)
    this.rainGain.gain.setTargetAtTime(rainy ? rainLevel * rainScale : 0, now, 1.6)
    this.windFilter.frequency.setTargetAtTime(this.weatherIndoors ? 180 : 650 + this.weatherWind * 550, now, 1.3)
    this.windGain.gain.setTargetAtTime((windBase + this.weatherWind * 0.045) * windScale, now, 1.8)
  }

  private playWeatherChirp(startFrequency: number, endFrequency: number, duration: number, level: number): void {
    const context = this.context
    if (!context || !this.weatherBus) return
    const now = context.currentTime
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = "sine"
    oscillator.frequency.setValueAtTime(startFrequency, now)
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + duration * 0.5)
    oscillator.frequency.exponentialRampToValueAtTime(startFrequency * 0.88, now + duration)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(level, now + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    oscillator.connect(gain)
    gain.connect(this.weatherBus)
    oscillator.start(now)
    oscillator.stop(now + duration + 0.01)
  }

  private playRainDrip(): void {
    const context = this.context
    if (!context || !this.weatherBus) return
    const now = context.currentTime
    const source = context.createBufferSource()
    const filter = context.createBiquadFilter()
    const gain = context.createGain()
    this.rainDripBuffer ??= this.createNoise(context, 0.12, false)
    source.buffer = this.rainDripBuffer
    filter.type = "bandpass"
    filter.frequency.value = 1750 + Math.random() * 1700
    filter.Q.value = 0.8
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(0.004 + Math.random() * 0.004, now + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(this.weatherBus)
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect() }
    source.start(now)
    source.stop(now + 0.13)
  }

  private playThunder(): void {
    const context = this.context
    if (!context || !this.weatherBus) return
    const now = context.currentTime
    const source = context.createBufferSource()
    const filter = context.createBiquadFilter()
    const gain = context.createGain()
    this.thunderBuffer ??= this.createNoise(context, 5, true)
    source.buffer = this.thunderBuffer
    filter.type = "lowpass"
    filter.frequency.value = 145
    filter.Q.value = 0.6
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(this.weatherIndoors ? 0.025 : 0.11, now + 0.7)
    gain.gain.setTargetAtTime(this.weatherIndoors ? 0.012 : 0.035, now + 0.7, 0.65)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.8)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(this.weatherBus)
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect() }
    source.start(now)
    source.stop(now + 5)
  }

  private syncWalking(): void {
    const context = this.context
    if (!context || context.state !== "running" || !this.walking || !this.footstepsEnabled || this.disposed) {
      this.stopWalking()
      return
    }
    if (this.stepTimer === undefined) {
      this.playStep()
      this.stepTimer = window.setInterval(() => this.playStep(), 410)
    }
  }

  private playStep(): void {
    const context = this.context
    if (!context || context.state !== "running" || !this.walking || !this.footstepsEnabled || this.disposed) return
    try {
      this.footstepBuffer ??= this.createNoise(context, 0.12, false)
      const now = context.currentTime
      const noise = context.createBufferSource()
      const filter = context.createBiquadFilter()
      const gain = context.createGain()
      noise.buffer = this.footstepBuffer
      filter.type = "lowpass"
      filter.frequency.value = 760
      filter.Q.value = 0.7
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.048, now + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11)
      noise.connect(filter)
      filter.connect(gain)
      gain.connect(context.destination)
      noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect() }
      noise.start(now)
      noise.stop(now + 0.12)
      const tone = context.createOscillator()
      const toneGain = context.createGain()
      tone.type = "sine"
      tone.frequency.setValueAtTime(92, now)
      tone.frequency.exponentialRampToValueAtTime(58, now + 0.08)
      toneGain.gain.setValueAtTime(0.0001, now)
      toneGain.gain.exponentialRampToValueAtTime(0.012, now + 0.01)
      toneGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09)
      tone.connect(toneGain)
      toneGain.connect(context.destination)
      tone.onended = () => { tone.disconnect(); toneGain.disconnect() }
      tone.start(now)
      tone.stop(now + 0.1)
    } catch {
      this.stopWalking()
    }
  }

  private createNoise(context: AudioContext, seconds: number, loop: boolean): AudioBuffer {
    const buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * seconds)), context.sampleRate)
    const samples = buffer.getChannelData(0)
    let value = 0
    for (let i = 0; i < samples.length; i++) {
      const noise = Math.random() * 2 - 1
      value = loop ? value * 0.96 + noise * 0.04 : noise
      samples[i] = loop ? value * 3 : noise
    }
    return buffer
  }

  private stopWalking(): void {
    if (this.stepTimer !== undefined) window.clearInterval(this.stepTimer)
    this.stepTimer = undefined
  }
}
