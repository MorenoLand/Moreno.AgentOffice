import type { OfficeState } from "./boss_computer";
import { isCustomLaptopIcon, modelIconOptions, modelIconPath, readCustomLaptopIcon } from "./model_icons";
import type { OfficeSettingsState } from "./settings";
import { enableAppOrdering } from "./app_order";
import { api } from "./api";
import { youtubeVideoId, type YouTubePlayback, type YouTubeProjection } from "./youtube";

export interface PhoneWorker { terminalId: string; name: string; state: string; isLeaving: boolean; icon: string }

export class OfficePhone {
  private root = document.createElement("aside");
  private screen = document.createElement("div");
  private openState = false;
  private youtubeSlot?: HTMLElement;
  private youtubeStatus?: HTMLElement;
  private youtubePlaceholder?: HTMLElement;
  private youtubeCast?: HTMLButtonElement;
  private youtubeTitle?: HTMLElement;
  private audio = document.createElement("audio");
  private musicTracks: { name: string; url: string }[] = [];
  private musicURLs: string[] = [];

  constructor(private actions: {
    owner: boolean;
    canReset: boolean;
    workers: () => PhoneWorker[];
    hire: () => void;
    fire: (terminalId: string) => void;
    edit: (terminalId: string, name: string, icon: string) => Promise<void>;
    settings: () => OfficeSettingsState;
    setSetting: (key: keyof OfficeSettingsState, value: boolean) => void;
    resetObjects: () => void;
    unstuck: () => void;
    signOut: () => void;
    office: () => OfficeState;
    blindControls: () => { id: string; label: string }[];
    updateOffice: (change: Partial<OfficeState>) => void;
    atDesk: () => boolean;
    youtube?: YouTubeProjection;
    openWorker?: (terminalId: string) => void;
    whiteboard?: () => void;
    vehicles?: () => { id: number; name: string; kind: string; available: boolean }[];
    drive?: (id: number, arrival: boolean) => Promise<void>;
    weather?: () => { kind: string; season: string; daylight: number };
  }, private profileKey = "default") {
    this.root.id = "office-phone";
    this.root.className = "office-phone";
    this.root.setAttribute("aria-label", "Office phone");
    this.screen.className = "phone-screen";
    const island = document.createElement("div");
    island.className = "phone-island";
    const camera = document.createElement("span");
    camera.className = "phone-camera";
    island.appendChild(camera);
    const power = document.createElement("div");
    power.className = "phone-power-button";
    const volume = document.createElement("div");
    volume.className = "phone-volume-buttons";
    this.root.append(power, volume);
    this.screen.appendChild(island);
    this.root.appendChild(this.screen);
    document.body.appendChild(this.root);
    this.actions.youtube?.subscribe((playback) => this.renderYouTube(playback));
    this.audio.controls = true; this.audio.preload = "metadata"; this.audio.style.cssText = "width:100%;margin:12px 0";
    window.addEventListener("keydown", (event) => {
      if (event.code !== "ArrowUp" || event.repeat) return;
      if (document.body.classList.contains("boss-computer-open") || document.body.classList.contains("terminal-open") || document.body.classList.contains("settings-open")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openState ? this.close() : this.open();
    }, true);
  }

  get isOpen(): boolean { return this.openState; }
  open(): void { this.openState = true; this.root.classList.add("open"); document.body.classList.add("phone-open"); this.home(); }
  close(): void { this.openState = false; this.root.classList.remove("open"); document.body.classList.remove("phone-open", "settings-open"); }

  private shell(title: string, back?: () => void): HTMLElement {
    document.body.classList.remove("settings-open");
    this.screen.replaceChildren();
    this.youtubeSlot = this.youtubeStatus = this.youtubePlaceholder = this.youtubeTitle = undefined; this.youtubeCast = undefined;
    const status = document.createElement("div");
    status.className = "phone-status";
    const time = document.createElement("span");
    time.className = "phone-time";
    time.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const indicators = document.createElement("div");
    indicators.className = "phone-status-icons";
    indicators.innerHTML = `<span>5G</span><span class="phone-signal" aria-hidden="true">▮▮▮</span><span class="phone-battery" aria-label="Battery 84 percent"><i></i></span>`;
    const close = document.createElement("button");
    close.className = "phone-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close phone");
    close.addEventListener("click", () => this.close());
    status.append(time, indicators, close);
    this.screen.appendChild(status);
    const page = document.createElement("main");
    page.className = "phone-page";
    if (back) {
      const nav = document.createElement("button");
      nav.textContent = "‹";
      nav.setAttribute("aria-label", "Back");
      nav.className = "phone-back";
      nav.addEventListener("click", back);
      const heading = document.createElement("div");
      heading.className = "phone-page-heading";
      const label = document.createElement("span");
      label.textContent = title;
      heading.append(nav, label);
      page.appendChild(heading);
    }
    this.screen.appendChild(page);
    const home = document.createElement("div");
    home.className = "phone-home-indicator";
    this.screen.appendChild(home);
    return page;
  }

  private button(label: string, action: () => void, primary = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = `phone-button${primary ? " primary" : ""}`;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  private home(): void {
    const page = this.shell("");
    const officeState = this.actions.office(), workers = this.actions.workers();
    const eyebrow = document.createElement("div");
    eyebrow.className = "phone-eyebrow";
    eyebrow.textContent = "YOUR WORKSPACE";
    const title = document.createElement("div");
    title.className = "phone-home-title";
    title.textContent = "Office";
    const date = document.createElement("div");
    date.className = "phone-date";
    date.textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const summary = document.createElement("div");
    summary.className = `phone-office-summary${officeState.officeClosed ? " closed" : ""}`;
    const summaryDot = document.createElement("span");
    summaryDot.className = "phone-summary-dot";
    const summaryText = document.createElement("span");
    summaryText.textContent = `${officeState.officeClosed ? "Office closed" : "Office open"} · ${workers.length} ${workers.length === 1 ? "worker" : "workers"}`;
    summary.append(summaryDot, summaryText);
    const grid = document.createElement("div");
    grid.className = "phone-app-grid";
    grid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    grid.style.gridTemplateRows = "repeat(4, 80px)";
    grid.style.gridAutoRows = "80px";
    const apps: [string, string, string, string, () => void][] = [];
    if (this.actions.owner) apps.push(["team", "◉", "Team", `${workers.length} people`, () => this.team()], ["office", "⌂", "Office", officeState.officeClosed ? "Closed for the day" : "Open for the day", () => this.office()], ["lights", "☼", "Lights", officeState.lightRows.every(Boolean) ? "All on" : "Adjust rooms", () => this.lights()], ["blinds", "▤", "Blinds", "Window shades", () => this.blinds()]);
    if (this.actions.owner || this.actions.weather) apps.push(["weather", "☁", "Weather", this.actions.weather?.().kind.replaceAll("-", " ") ?? String(officeState.season), () => this.weather()]);
    if (this.actions.youtube) apps.push(["youtube", "▶", "YouTube", "Watch or cast", () => this.youtube()]);
    if (this.actions.openWorker) apps.push(["sessions", "▣", "Sessions", "Worker terminals", () => this.sessions()]);
    apps.push(["music", "♫", "Music", "Your audio library", () => this.music()]);
    if (this.actions.whiteboard) apps.push(["whiteboard", "▱", "Whiteboard", "Shared board", () => { this.close(); this.actions.whiteboard?.(); }]);
    if (this.actions.vehicles && this.actions.drive) apps.push(["garage", "▰", "Garage", "Drive into town", () => this.garage()]);
    apps.push(["settings", "⚙", "Settings", "Preferences", () => this.settings()]);
    for (const [id, icon, name, detail, open] of apps) {
      const card = document.createElement("button");
      card.className = "phone-app-card";
      card.dataset.appOrderId = id;
      card.style.height = "80px";
      card.style.cursor = "grab";
      const glyph = document.createElement("span");
      glyph.className = "phone-app-icon";
      glyph.textContent = icon;
      const label = document.createElement("span");
      label.className = "phone-app-label";
      const appName = document.createElement("strong");
      appName.textContent = name;
      const appDetail = document.createElement("small");
      appDetail.textContent = detail;
      label.append(appName, appDetail);
      card.append(glyph, label);
      card.addEventListener("click", open);
      grid.appendChild(card);
    }
    const appStorageKey = `agent-office-phone-apps:${encodeURIComponent(this.profileKey)}`;
    enableAppOrdering(grid, appStorageKey, "row", true, "agent-office-phone-app-order", 2);
    page.append(eyebrow, title, date, summary, grid);
    const signOut = this.button("Sign out", this.actions.signOut);
    signOut.classList.add("phone-signout");
    signOut.style.cssText = "width:100%;margin-top:12px";
    page.appendChild(signOut);
  }

  private team(): void {
    const page = this.shell("Team", () => this.home());
    const workers = this.actions.workers();
    const active = workers.filter((worker) => worker.state === "working" && !worker.isLeaving).length;
    const summary = document.createElement("div");
    summary.className = "phone-section-summary";
    summary.textContent = `${active} working · ${workers.length} total`;
    page.append(summary, this.button("Hire a worker", this.actions.hire, true));
    const list = document.createElement("div");
    list.className = "phone-worker-list";
    for (const worker of workers) {
      const row = document.createElement("section");
      row.className = "phone-worker-card";
      const identity = document.createElement("div");
      identity.className = "phone-worker-identity";
      const avatar = document.createElement("span");
      avatar.className = "phone-worker-avatar";
      avatar.textContent = worker.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
      const details = document.createElement("div");
      details.className = "phone-worker-details";
      const name = document.createElement("strong");
      name.className = "phone-worker-name";
      name.textContent = worker.name;
      const state = document.createElement("small");
      state.className = "phone-worker-state";
      state.dataset.state = worker.isLeaving ? "leaving" : worker.state;
      state.textContent = worker.isLeaving ? "Heading home" : worker.state.replaceAll("_", " ");
      details.append(name, state);
      identity.append(avatar, details);
      const actions = document.createElement("div");
      actions.className = "phone-worker-actions";
      const fire = this.button("Send home", () => this.actions.fire(worker.terminalId));
      fire.classList.add("phone-send-home");
      fire.disabled = worker.isLeaving;
      const edit = this.button("Edit", () => {
        if (row.querySelector(".phone-worker-edit")) return;
        const form = document.createElement("div");
        form.className = "phone-worker-edit";
        const input = document.createElement("input");
        input.value = worker.name;
        input.maxLength = 80;
        input.setAttribute("aria-label", "Worker nickname");
        input.className = "phone-edit-input";
        const icon = document.createElement("select");
        icon.setAttribute("aria-label", "Worker logo");
        for (const option of modelIconOptions) {
          const item = document.createElement("option");
          item.value = option.id;
          item.textContent = option.label;
          item.selected = option.id === worker.icon;
          icon.appendChild(item);
        }
        const customOption = document.createElement("option");
        customOption.value = "custom";
        customOption.textContent = "Custom image";
        icon.appendChild(customOption);
        const iconFile = document.createElement("input");
        iconFile.type = "file";
        iconFile.accept = "image/png,image/jpeg,image/webp";
        iconFile.setAttribute("aria-label", "Upload a custom laptop icon");
        iconFile.className = "phone-edit-input";
        const preview = document.createElement("img");
        preview.alt = "Laptop icon preview";
        preview.style.cssText = "width:40px;height:40px;object-fit:contain;grid-column:1/-1";
        const error = document.createElement("small");
        let customIcon = isCustomLaptopIcon(worker.icon) ? worker.icon : "";
        icon.value = customIcon ? "custom" : worker.icon || "";
        const selectedIcon = () => icon.value === "custom" ? customIcon : modelIconPath(icon.value);
        const showPreview = () => { const path = selectedIcon(); if (path) { preview.src = path; preview.hidden = false; } else { preview.removeAttribute("src"); preview.hidden = true; } };
        showPreview();
        icon.addEventListener("change", () => { if (icon.value !== "custom") { customIcon = ""; iconFile.value = ""; } showPreview(); });
        iconFile.addEventListener("change", () => {
          const file = iconFile.files?.[0];
          if (!file) return;
          void readCustomLaptopIcon(file).then((value) => { customIcon = value; icon.value = "custom"; error.textContent = "Custom icon ready."; showPreview(); }).catch((problem) => { error.textContent = problem instanceof Error ? problem.message : String(problem); });
        });
        icon.className = "phone-edit-input";
        const save = this.button("Save changes", () => {
          const title = input.value.trim();
          if (!title) { input.focus(); return; }
          if (icon.value === "custom" && !customIcon) { error.textContent = "Choose a custom image first."; return; }
          void this.actions.edit(worker.terminalId, title, icon.value === "custom" ? customIcon : icon.value).then(() => this.team()).catch((problem) => { error.textContent = problem instanceof Error ? problem.message : "Could not save worker details"; });
        }, true);
        form.append(input, icon, iconFile, preview, save, error);
        row.appendChild(form);
      });
      edit.classList.add("phone-edit-button");
      actions.append(edit, fire);
      row.append(identity, actions);
      list.appendChild(row);
    }
    if (!list.childElementCount) {
      const empty = document.createElement("p");
      empty.className = "phone-empty-state";
      empty.textContent = "No workers are in the office.";
      list.appendChild(empty);
    }
    page.appendChild(list);
  }

  private office(): void {
    const page = this.shell("Office", () => this.home());
    const state = this.actions.office();
    const status = document.createElement("div");
    status.className = `phone-office-status${state.officeClosed ? " closed" : ""}`;
    const mark = document.createElement("span");
    mark.className = "phone-summary-dot";
    const label = document.createElement("strong");
    label.textContent = state.officeClosed ? "Closed for the day" : "Open and running";
    status.append(mark, label);
    page.appendChild(status);
    page.appendChild(this.button(state.officeClosed ? "Open office for the day" : "Close office for the day", () => {
      this.actions.updateOffice({ officeClosed: !state.officeClosed });
      this.office();
    }, true));
    const note = document.createElement("p");
    note.className = "phone-helper-text";
    note.textContent = state.officeClosed ? "Workers are home. Their desks and computers stay ready for tomorrow." : "Close the office to send the team home for the day.";
    page.appendChild(note);
  }

  private lights(): void {
    const page = this.shell("Lights", () => this.home());
    const state = this.actions.office();
    const description = document.createElement("p");
    description.className = "phone-helper-text";
    description.textContent = "Control lighting by area.";
    page.appendChild(description);
    const setRow = (index: number) => {
      const rows = [...state.lightRows] as [boolean, boolean, boolean];
      rows[index] = !rows[index];
      this.actions.updateOffice({ lightRows: rows });
      this.lights();
    };
    state.lightRows.forEach((on, index) => page.appendChild(this.button(`Ceiling row ${index + 1} · ${on ? "On" : "Off"}`, () => setRow(index))));
    page.appendChild(this.button(`Break room · ${state.breakroomOn ? "On" : "Off"}`, () => { this.actions.updateOffice({ breakroomOn: !state.breakroomOn }); this.lights(); }));
  }

  private blinds(): void {
    const page = this.shell("Blinds", () => this.home());
    const state = this.actions.office(), stages = { ...state.blindStages }, controls = this.actions.blindControls(), selects: HTMLSelectElement[] = [];
    const description = document.createElement("p");
    description.className = "phone-helper-text";
    description.textContent = "Set each window shade independently.";
    page.appendChild(description);
    const setAll = (stage: number) => { controls.forEach(({ id }) => { stages[id] = stage; }); selects.forEach((select) => { select.value = String(stage); }); this.actions.updateOffice({ blindStage: stage, blindStages: { ...stages } }); };
    const bulk = document.createElement("div");
    bulk.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 12px";
    bulk.append(this.button("Open all", () => setAll(0), true), this.button("Close all", () => setAll(2)));
    page.appendChild(bulk);
    for (const control of controls) {
      const row = document.createElement("label");
      row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 112px;align-items:center;gap:8px;margin:0 0 8px;padding:10px 11px;border:1px solid #ffffffbf;border-radius:12px;background:#ffffff99;color:#203842;font-size:12px;font-weight:650";
      const name = document.createElement("span"); name.textContent = control.label;
      const select = document.createElement("select"); select.setAttribute("aria-label", control.label); select.className = "phone-edit-input";
      for (const [value, label] of [[0, "Open"], [1, "Half"], [2, "Closed"]] as [number, string][]) { const option = document.createElement("option"); option.value = String(value); option.textContent = label; select.appendChild(option); }
      select.value = String(stages[control.id] ?? state.blindStage ?? 0);
      select.addEventListener("change", () => { const stage = Number(select.value); stages[control.id] = stage; this.actions.updateOffice({ blindStage: stage, blindStages: { ...stages } }); });
      selects.push(select);
      row.append(name, select); page.appendChild(row);
    }
  }

  private weather(): void {
    const page = this.shell("Weather", () => this.home());
    const weather = this.actions.weather?.();
    if (weather) { const current = document.createElement("strong"); current.style.cssText = "display:block;font-size:19px;text-transform:capitalize;margin-bottom:8px"; current.textContent = weather.kind.replaceAll("-", " "); const conditions = document.createElement("p"); conditions.className = "phone-helper-text"; conditions.textContent = `${weather.season} · ${weather.daylight > 0.05 ? "Daylight" : "Night"}`; page.append(current, conditions); }
    if (!this.actions.owner) return;
    const description = document.createElement("p");
    description.className = "phone-helper-text";
    description.textContent = "Choose the office's seasonal weather.";
    const select = document.createElement("select"); select.setAttribute("aria-label", "Seasonal weather"); select.className = "phone-edit-input";
    for (const [value, label] of [["auto", "Automatic"], ["spring", "Spring"], ["summer", "Summer"], ["autumn", "Autumn"], ["winter", "Winter"]] as [OfficeState["season"], string][]) { const option = document.createElement("option"); option.value = value; option.textContent = label; select.appendChild(option); }
    select.value = this.actions.office().season;
    select.addEventListener("change", () => this.actions.updateOffice({ season: select.value as OfficeState["season"] }));
    page.append(description, select);
  }

  private garage(): void {
    const page = this.shell("Garage", () => this.home()), vehicles = this.actions.vehicles?.() ?? [], status = document.createElement("p"); status.className = "phone-helper-text"; status.setAttribute("role", "status"); page.appendChild(status);
    const list = document.createElement("div"); list.className = "phone-worker-list";
    for (const vehicle of vehicles) {
      const row = document.createElement("section"); row.className = "phone-worker-card";
      const name = document.createElement("strong"); name.textContent = vehicle.name;
      const kind = document.createElement("small"); kind.className = "phone-worker-state"; kind.textContent = `${vehicle.kind} · ${vehicle.available ? "Available" : "In use"}`;
      const drive = this.button("Drive from town", () => { drive.disabled = true; status.textContent = "Requesting vehicle…"; void this.actions.drive?.(vehicle.id, true).then(() => { this.close(); }).catch((error) => { drive.disabled = false; status.textContent = error instanceof Error ? error.message : String(error); }); }, true); drive.disabled = !vehicle.available;
      row.append(name, kind, drive); list.appendChild(row);
    }
    if (!vehicles.length) { const empty = document.createElement("p"); empty.className = "phone-empty-state"; empty.textContent = "No vehicles are available."; list.appendChild(empty); }
    page.appendChild(list);
  }

  private youtube(): void {
    const player = this.actions.youtube; if (!player) return;
    const page = this.shell("YouTube", () => this.home()), heading = page.querySelector<HTMLElement>(".phone-page-heading")!;
    const cast = this.button("Cast", () => { const casting = player.playback.target !== "tv"; player.setTarget(casting ? "tv" : "auto"); if (casting) this.close(); });
    cast.style.cssText = "margin-left:auto;min-height:34px;padding:6px 10px;font-size:11px"; heading.appendChild(cast); this.youtubeCast = cast;
    const form = document.createElement("form"); form.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:6px;margin-bottom:12px";
    const input = document.createElement("input"); input.inputMode = "url"; input.className = "phone-edit-input"; input.placeholder = "Paste a YouTube link"; input.setAttribute("aria-label", "YouTube link"); input.value = player.playback.videoId ? `https://www.youtube.com/watch?v=${player.playback.videoId}` : "";
    const play = this.button("▶", () => {}); play.type = "submit"; play.setAttribute("aria-label", "Play video"); form.append(input, play);
    const slot = document.createElement("div"); slot.className = "phone-youtube-slot"; slot.style.cssText = "width:100%;aspect-ratio:16/9;background:#05080a;border-radius:10px;overflow:hidden"; this.youtubeSlot = slot;
    const empty = document.createElement("p"); empty.className = "phone-helper-text"; this.youtubePlaceholder = empty;
    const title = document.createElement("strong"); title.style.cssText = "display:block;margin-top:12px;font-size:13px;overflow-wrap:anywhere"; this.youtubeTitle = title;
    const status = document.createElement("p"); status.className = "phone-helper-text"; status.setAttribute("role", "status"); this.youtubeStatus = status;
    const controls = document.createElement("div"); controls.style.cssText = "display:flex;flex-wrap:wrap;gap:7px"; controls.append(this.button("Play", () => player.resume()), this.button("Pause", () => player.pause()), this.button("Stop", () => player.stop()));
    form.addEventListener("submit", (event) => { event.preventDefault(); const id = youtubeVideoId(input.value); if (!id) { status.textContent = "Paste a valid YouTube video link."; return; } player.play(id, slot); });
    page.append(form, slot, empty, title, controls, status); player.attach(slot); this.renderYouTube(player.playback);
  }

  private renderYouTube(playback: Readonly<YouTubePlayback>): void {
    if (!this.youtubeSlot || !this.youtubeStatus || !this.youtubePlaceholder || !this.youtubeCast || !this.youtubeTitle) return;
    const casting = playback.target === "tv", active = !!playback.videoId;
    this.youtubeSlot.hidden = !active || casting; this.youtubeCast.disabled = !active; this.youtubeCast.textContent = casting ? "Cast off" : "Cast"; this.youtubeCast.setAttribute("aria-pressed", String(casting));
    this.youtubePlaceholder.hidden = active && !casting; this.youtubePlaceholder.textContent = casting ? "TV selected. Cast off to return the video here." : "Paste a video link to watch on your phone.";
    this.youtubeTitle.textContent = playback.title || (active ? `Video · ${playback.videoId}` : "");
    const destination = casting ? "Office TV" : "this phone";
    this.youtubeStatus.textContent = playback.error || (playback.autoplayBlocked ? "Press Play to start the video." : !active ? "" : playback.state === 1 ? `Playing on ${destination}.` : playback.state === 2 ? "Paused." : playback.state === 0 ? "Video ended." : playback.state === 3 ? "Buffering…" : playback.ready ? "Ready to play." : "Loading YouTube…");
  }

  private sessions(): void {
    const page = this.shell("Sessions", () => this.home()), list = document.createElement("div"); list.className = "phone-worker-list";
    for (const worker of this.actions.workers()) { const button = this.button(`${worker.name} · ${worker.isLeaving ? "Heading home" : worker.state.replaceAll("_", " ")}`, () => { this.close(); this.actions.openWorker?.(worker.terminalId); }); button.disabled = worker.isLeaving; button.style.cssText = "text-align:left;overflow-wrap:anywhere"; list.appendChild(button); }
    if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "phone-empty-state"; empty.textContent = "No active worker sessions."; list.appendChild(empty); }
    page.appendChild(list);
  }

  private music(): void {
    const page = this.shell("Music", () => this.home()), files = document.createElement("input"), status = document.createElement("p"), list = document.createElement("div");
    files.type = "file"; files.accept = "audio/*,.flac,.opus"; files.multiple = true; files.className = "phone-edit-input"; files.setAttribute("aria-label", "Choose music files"); status.className = "phone-helper-text"; status.setAttribute("role", "status"); list.style.cssText = "display:grid;gap:7px";
    const renderTracks = () => { list.replaceChildren(); for (const track of this.musicTracks) { const button = this.button(track.name, () => { this.actions.youtube?.pause(); this.audio.src = track.url; void this.audio.play().catch((error) => { status.textContent = error instanceof Error ? error.message : String(error); }); }); button.style.cssText = "text-align:left;overflow-wrap:anywhere"; list.appendChild(button); } status.textContent = this.musicTracks.length ? `${this.musicTracks.length} tracks` : "Choose audio files to add to your library."; };
    files.addEventListener("change", () => { this.audio.pause(); for (const url of this.musicURLs) URL.revokeObjectURL(url); this.musicURLs = []; this.musicTracks = Array.from(files.files ?? []).map((file) => { const url = URL.createObjectURL(file); this.musicURLs.push(url); return { name: file.name, url }; }); renderTracks(); });
    this.audio.onerror = () => { status.textContent = this.audio.error?.message || "The audio file could not be played."; };
    page.append(files, this.audio, status, list); renderTracks();
    if (this.actions.owner) {
      const form = document.createElement("form"); form.style.cssText = "display:grid;gap:8px;margin-top:12px";
      const folder = document.createElement("input"); folder.className = "phone-edit-input"; folder.placeholder = "Music folder on the host"; folder.setAttribute("aria-label", "Music folder on the host");
      const scan = this.button("Load folder", () => {}); scan.type = "submit"; form.append(folder, scan);
      form.addEventListener("submit", (event) => { event.preventDefault(); const path = folder.value.trim(); if (!path) { folder.focus(); return; } scan.disabled = true; status.textContent = "Loading music…"; void api.request<{ id: string; name: string }[]>("scan_music", { path }).then((tracks) => { this.musicTracks = tracks.map((track) => ({ name: track.name, url: `/music/${encodeURIComponent(track.id)}` })); renderTracks(); }).catch((error) => { status.textContent = error instanceof Error ? error.message : String(error); }).finally(() => { scan.disabled = false; }); }); page.appendChild(form);
    }
  }

  private settings(): void {
    const page = this.shell("Settings", () => this.home());
    document.body.classList.add("settings-open");
    const state = this.actions.settings();
    const rows: [keyof OfficeSettingsState, string][] = [["deskMarkers", "Available desk markers"], ["playerNameplates", "Player nameplates"], ["chatBubbles", "Chat bubbles"], ["footsteps", "Footsteps"], ["officeAmbience", "Office ambience"]];
    for (const [key, text] of rows) {
      const row = document.createElement("label");
      row.className = "phone-setting-row";
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:11px 12px;margin:0 0 8px;border:1px solid #ffffffbf;border-radius:12px;background:#ffffff99;color:#203842;font-size:12px;font-weight:650";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state[key];
      input.style.cssText = "width:17px;height:17px;margin:0;accent-color:#258a5a";
      input.addEventListener("change", () => this.actions.setSetting(key, input.checked));
      row.append(input, document.createTextNode(text));
      page.appendChild(row);
    }
    if (this.actions.canReset) { const reset = this.button("Reset moved objects", this.actions.resetObjects); reset.style.cssText = "width:100%;margin-top:8px"; page.appendChild(reset); }
    const unstuck = this.button("I'm stuck", this.actions.unstuck); unstuck.style.cssText = "width:100%;margin-top:8px"; page.appendChild(unstuck);
  }
}
