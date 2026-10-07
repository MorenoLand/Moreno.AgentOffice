import "./style.css";
import * as THREE from "three";
import { api, type AgentProfile, type Avatar, type Terminal, type User } from "./api";
import { defaultModelIcon, isCustomLaptopIcon, modelIconOptions, modelIconPath, readCustomLaptopIcon } from "./model_icons";
import { Office, type MovablePosition, type Seat } from "./office";
import { loadOfficeModels } from "./models";
import { VehicleCoordinator } from "./vehicles_client";
import { Player, RemoteAvatars } from "./player";
import { Workers, type Worker } from "./worker";
import { TerminalOverlay } from "./terminal";
import { buildGate, Hud } from "./ui";
import { Whiteboard } from "./whiteboard";
import { StickyNoteEditor } from "./sticky_note_editor";
import { ChatDisplay, type ChatMessage } from "./chat";
import { ResumeWorkers } from "./resume";
import { BossComputer, type OfficeState } from "./boss_computer";
import { OfficeAudio } from "./audio";
import { OfficeSettingsPanel, type OfficeSettingsState } from "./settings";
import { Dictation } from "./dictation";
import { OfficePhone } from "./phone";
import { OfficeDog } from "./dog";
import { YouTubeProjection } from "./youtube";
import { supportsImmersiveVR } from "./xr_support";
import { TerminalScreen, type DesktopPreview } from "./terminal_screen";

const app = document.getElementById("app")!;
const xrOverlay = document.getElementById("xr-overlay")!;
const moveBodyUIToOverlay = (node: Node): void => { if (node !== app && node !== xrOverlay && !(node instanceof HTMLScriptElement) && !(node instanceof HTMLElement && node.matches(".html2canvas-container,[data-desktop-capture-id],[data-youtube-surface]")) && node.parentNode === document.body) xrOverlay.appendChild(node); };
const bodyUIObserver = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(moveBodyUIToOverlay)));
bodyUIObserver.observe(document.body, { childList: true });
Array.from(document.body.childNodes).forEach(moveBodyUIToOverlay);
const gate = buildGate((user) => {
  gate.remove();
  start(user).catch(fail);
});
app.appendChild(gate);

function fail(problem: unknown): void {
  const message = problem instanceof Error ? `${problem.message}\n${problem.stack ?? ""}` : String(problem);
  console.error("agent-office failed to start", problem);
  if (document.getElementById("crash")) return;
  const panel = document.createElement("pre");
  panel.id = "crash";
  panel.textContent = `The office failed to start.\n\n${message}`;
  document.body.appendChild(panel);
}

addEventListener("unhandledrejection", (event) => fail(event.reason));
addEventListener("error", (event) => fail(event.error ?? event.message));

/** A hang leaves no exception to catch, so bound the handshake explicitly. */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (problem) => { clearTimeout(timer); reject(problem); }
    );
  });
}

void api
  .rpc<{ allowCreate: boolean }>("auth_config")
  .then(({ allowCreate }) => gate.setAllowCreate(allowCreate))
  .catch(() => undefined);

interface Focus {
  kind: "seat" | "worker";
  seat: Seat;
  worker?: Worker;
}

type XRTarget = { kind: "desk" | "worker-computer"; seatId: number } | { kind: "worker"; id: string } | { kind: "boss-computer" } | { kind: "exit" } | { kind: "elevator" } | { kind: "dog" } | { kind: "watercooler" } | { kind: "breakroom-switch" } | { kind: "light-row"; index: number } | { kind: "blind-control"; id: string } | { kind: "board" } | { kind: "coffee" } | { kind: "bin" } | { kind: "vehicle"; id: number } | { kind: "world-action"; action: "lights" | "breakroom" | "office" };

document.addEventListener("contextmenu", (event) => event.preventDefault());

async function start(user: User): Promise<void> {
  const readOnly = user.role === "guest";
  const models = await withDeadline(loadOfficeModels(), 15000, "office models");
  const office = new Office(app, models);
  const bossDesktopScreen = new TerminalScreen(100, 28);
  const bossTerminalScreens = new Map<string, TerminalScreen>();
  const bossShellTerminalIds = new Set<string>();
  const bossScreenCanvas = document.createElement("canvas");
  bossScreenCanvas.width = 768;
  bossScreenCanvas.height = 459;
  const bossScreenContext = bossScreenCanvas.getContext("2d")!;
  const bossScreenTexture = new THREE.CanvasTexture(bossScreenCanvas);
  bossScreenTexture.colorSpace = THREE.SRGBColorSpace;
  bossScreenTexture.generateMipmaps = false;
  bossScreenTexture.minFilter = THREE.LinearFilter;
  bossScreenTexture.magFilter = THREE.LinearFilter;
  office.bossLaptop.screen.material = new THREE.MeshBasicMaterial({ map: bossScreenTexture, toneMapped: false });
  let bossDesktopPreview: DesktopPreview | null = null;
  const bossTerminalScreen = (id: string) => { let screen = bossTerminalScreens.get(id); if (!screen) { screen = new TerminalScreen(100, 28); bossTerminalScreens.set(id, screen); } return screen; };
  const repaintBossScreen = () => { (bossDesktopPreview?.terminal ? bossTerminalScreen(bossDesktopPreview.key) : bossDesktopScreen).paint(bossScreenContext, bossScreenCanvas.width, bossScreenCanvas.height); bossScreenTexture.needsUpdate = true; };
  let bossPreviewSignature = "";
  const updateBossScreen = (preview: DesktopPreview) => { const signature = `${preview.key}:${preview.title}:${preview.terminal}:${preview.snapshotId ?? 0}`; bossDesktopPreview = preview; if (signature !== bossPreviewSignature) { bossPreviewSignature = signature; (preview.terminal ? bossTerminalScreen(preview.key) : bossDesktopScreen).setDesktopPreview(preview); repaintBossScreen(); } youtube.setDesktopPreview(preview, office.bossLaptop.screen); };
  repaintBossScreen();
  const youtube = new YouTubeProjection(office);
  const officeDog = new OfficeDog(office.scene);
  const player = new Player(office);
  player.setFirstPerson(user.role === "owner");
  const remotes = new RemoteAvatars(office);
  const workers = new Workers(api, office, document.body);
  const desktopMediaSubscriptions = new Map<string, () => void>();
  if (user.role === "owner") workers.setAttentionTarget(() => ({ x: player.x, y: player.worldY, z: player.z }));
  const workerIconKey = (id: string) => `agent-office-worker-icon-${id}`;
  const withLocalWorkerIcon = (terminal: Terminal): Terminal => ({ ...terminal, icon: localStorage.getItem(workerIconKey(terminal.id)) ?? terminal.icon });
  const terminalRecords = new Map<string, Terminal>();
  const overlay = new TerminalOverlay(api, readOnly, (id, cols, rows) => workers.resize(id, cols, rows));
  const shellOverlays = new Map<string, TerminalOverlay>();
  const openShellTerminal = (terminal: Terminal, targetLayer?: HTMLElement) => {
    terminalRecords.set(terminal.id, terminal);
    let shell = shellOverlays.get(terminal.id);
    if (!shell) {
      shell = new TerminalOverlay(api, false, (id, cols, rows) => workers.resize(id, cols, rows), `terminal-${terminal.id}`);
      shellOverlays.set(terminal.id, shell);
    }
    shell.setDesktopIdentity(terminal.id, terminal.title);
    shell.open(terminal, targetLayer ?? desktopWindowLayer);
    if (!targetLayer || targetLayer === desktopWindowLayer) {
      bossShellTerminalIds.add(terminal.id);
      const screen = bossTerminalScreen(terminal.id);
      screen.setDesktopPreview({ key: terminal.id, title: terminal.title, terminal: true });
      if (terminal.backlog) screen.write(terminal.backlog, () => { if (bossDesktopPreview?.terminal && bossDesktopPreview.key === terminal.id) repaintBossScreen(); });
      computer?.refreshDesktopScreen();
    }
    if (targetLayer && targetLayer === activeWorkerDesktop?.windowLayer) activeWorkerDesktop.refreshDesktopScreen();
  };
  const hud = new Hud(user);
  const board = new Whiteboard(office, readOnly);
  const chat = new ChatDisplay();
  const desktopWindowLayer = document.createElement("div");
  const computer = user.role === "owner" ? new BossComputer(api, office, desktopWindowLayer, openShellTerminal, () => board.openEditor(desktopWindowLayer), (message) => hud.toast(message), () => player.stand(), (closed) => { officeClosed = closed; localStorage.setItem("agent-office-office-closed", String(closed)); workers.setOfficeClosed(closed); }) : undefined;
  computer?.setHangPictureHandler(() => { void office.wallArt.begin(); });
  computer?.setDesktopScreenHandler(updateBossScreen);
  computer?.setYouTubeHandlers((id, slot) => youtube.play(id, slot, office.bossLaptop.screen), (target) => youtube.setTarget(target), () => youtube.stop(), (slot) => youtube.attach(slot, office.bossLaptop.screen));
  youtube.subscribe((state) => computer?.syncYouTubePlayback(state));
  const workerDesktops = new Map<string, BossComputer>();
  let activeWorkerDesktop: BossComputer | undefined;
  const audio = new OfficeAudio();
  const applySettings = (settings: OfficeSettingsState) => {
    office.showDeskMarkers = settings.deskMarkers;
    remotes.setNameplatesVisible(settings.playerNameplates);
    chat.setBubblesVisible(settings.chatBubbles);
    audio.setFootstepsEnabled(settings.footsteps);
    audio.setAmbienceEnabled(settings.officeAmbience);
  };
  const settings = new OfficeSettingsPanel(applySettings);
  applySettings(settings.getSettings());
  document.body.addEventListener("pointerdown", () => void audio.unlock(), { once: true });
  document.body.addEventListener("keydown", () => void audio.unlock(), { once: true });
  let resumes: ResumeWorkers | undefined;
  let officeClosed = localStorage.getItem("agent-office-office-closed") === "true";
  const rememberOfficeClosed = (closed: boolean) => {
    officeClosed = closed;
    localStorage.setItem("agent-office-office-closed", String(closed));
    workers.setOfficeClosed(closed);
  };

  // The socket must exist before anything calls api.request, otherwise the
  // request is queued against a null socket and never resolves.
  const self = { id: "", people: [] as Avatar[] };
  const vehicles = new VehicleCoordinator(api, office, () => self.id, {
    entered: (_car, pose) => { player.setVehiclePose(pose); phone?.close(); },
    moved: (_car, pose) => player.setVehiclePose(pose),
    exited: (_car, position) => { player.setVehiclePose(null); player.teleport(position.x, position.z, position.y, position.yaw + Math.PI); },
    horn: () => { void audio.unlock().then(() => audio.playHorn()); },
    lost: () => { player.setVehiclePose(null); player.resetToSafePosition(); hud.toast("Vehicle connection changed — returned to the office"); },
    error: (message) => hud.toast(message)
  }, !readOnly);
  const refreshRoster = () => hud.setRoster(self.people, workers.all, self.id);

  api.on("__reconnected", ({ connectionId }: { connectionId: string }) => {
    self.id = connectionId;
    remotes.sync(self.people, self.id);
    api.send("presence_move", { x: player.x, y: player.worldY, z: player.z, yaw: player.facing, seated: player.seated });
    void api.request<OfficeState>("office_state_get").then((state) => { applyOfficeState(state); workers.setOfficeClosed(officeClosed); }).catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem)));
    void api.request<Terminal[]>("list_terminals").then((list) => {
      for (const terminal of list) {
        const current = withLocalWorkerIcon(terminal);
        terminalRecords.set(current.id, current);
        const worker = workers.adopt(current);
        if (!worker) continue;
        workers.updateMetadata(current);
        const state = terminal.activityState ?? terminal.state;
        if (state === "working") workers.setState(terminal.id, "working");
        else if (state === "needs_input") workers.setState(terminal.id, "needs_input");
        else if (["done", "exited", "killed", "closed"].includes(state)) workers.setState(terminal.id, "done");
        else if (state === "error" || state === "failed") workers.setState(terminal.id, "failed");
        else if (state === "parked") workers.setState(terminal.id, "parked");
        else workers.setState(terminal.id, "idle");
      }
      refreshRoster();
      computer?.refreshSessions();
      void resumes?.restoreAll();
    }).catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem)));
    void board.load().catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem)));
  });
  api.on("presence", (list: Avatar[]) => {
    self.people = list;
    remotes.sync(list, self.id);
    chat.syncAvatars(list);
    refreshRoster();
  });
  api.on("presence_move", (avatar: Avatar) => {
    remotes.move(avatar.connectionId, avatar.x, avatar.y, avatar.z, avatar.yaw, avatar.seated);
    chat.moveAvatar(avatar);
  });
  api.on("chat-message", (message: ChatMessage) => chat.receive(message));
  api.on("dog-pet", ({ connectionId }: { connectionId: string }) => {
    if (connectionId === self.id) return;
    officeDog.pet(player.x, player.z);
    audio.playDog();
  });
  const blindStageCompatibilityKey = `agent-office-blind-stages:${user.username.toLowerCase()}`;
  let blindStageCompatibility: Record<string, number> | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem(blindStageCompatibilityKey) ?? "null"), validIds = new Set(office.blindControls.map((control) => control.id));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) blindStageCompatibility = Object.fromEntries(Object.entries(saved).filter(([id, stage]) => validIds.has(id) && Number.isInteger(stage) && Number(stage) >= 0 && Number(stage) <= 2)) as Record<string, number>;
  } catch {}
  const rememberBlindStages = (change: Partial<OfficeState>) => {
    try {
      if (change.blindStages) { blindStageCompatibility = { ...(blindStageCompatibility ?? office.blindStages), ...change.blindStages }; localStorage.setItem(blindStageCompatibilityKey, JSON.stringify(blindStageCompatibility)); }
      else if (typeof change.blindStage === "number") { blindStageCompatibility = null; localStorage.removeItem(blindStageCompatibilityKey); }
    } catch {}
  };
  const normalizeOfficeState = (received: OfficeState): OfficeState => {
    if (Object.keys(received.blindStages ?? {}).length) { blindStageCompatibility = null; try { localStorage.removeItem(blindStageCompatibilityKey); } catch {} return received; }
    return blindStageCompatibility ? { ...received, blindStages: { ...blindStageCompatibility } } : received;
  };
  const applyOfficeState = (received: OfficeState) => {
    const state = normalizeOfficeState(received);
    if (typeof state.officeClosed === "boolean") {
      officeClosed = state.officeClosed;
      localStorage.setItem("agent-office-office-closed", String(officeClosed));
    } else officeClosed = localStorage.getItem("agent-office-office-closed") === "true";
    office.setBlinds(state.blindStages ?? {}, state.blindStage);
    office.weather.setSeason(state.season ?? "auto");
    office.setWallArt(state.wallArt ?? []);
    office.setLights(state.lightsOn);
    office.setLightRows(state.lightRows);
    office.setStickyNotes(state.stickyNotes);
    office.setBreakroomLights(state.breakroomOn);
    computer?.setState({ ...state, officeClosed });
  };
  api.on("office-state", (state: OfficeState) => { applyOfficeState(state); workers.setOfficeClosed(officeClosed); });
  computer?.setBlindStagesFallbackHandler(rememberBlindStages);
  api.on("props-state", (positions: MovablePosition[]) => office.applyPropSnapshot(positions));
  api.on("prop-update", (position: MovablePosition) => office.applyPropPosition(position));
  api.on("props-reset", () => office.resetMovableObjects());
  api.on("open-url", ({ url }: { url: string }) => window.open(url, "_blank", "noopener"));
  api.on("open-path", ({ path }: { path: string }) => api.send("reveal_path", { path }));
  api.on("toast", ({ text }: { text: string }) => hud.toast(text));

  api.on("pending-guests", (guests: User[]) => {
    if (readOnly) return;
    hud.setPendingGuests(
      guests,
      (name) => api.send("auth_approve_guest", { username: name }),
      (name) => api.send("auth_deny_guest", { username: name })
    );
  });
  api.on("terminal-session", ({ session }: { session: Terminal }) => {
    const current = withLocalWorkerIcon(session);
    terminalRecords.set(current.id, current);
    workers.adopt(current);
    workers.updateMetadata(current);
    workerDesktops.get(current.id)?.updateWorkerTerminal(current);
    if (current.activityState === "working" || current.activityState === "needs_input" || current.activityState === "done" || current.activityState === "failed" || current.activityState === "parked") workers.setState(current.id, current.activityState);
    workers.write(session.id, session.backlog);
    overlay.updateMetadata(current);
    shellOverlays.get(session.id)?.updateMetadata(current);
    refreshRoster();
    computer?.refreshSessions();
    void resumes?.refresh();
  });
  api.on("terminal-output", ({ id, data }: { id: string; data: string }) => {
    overlay.ingest(id, data);
    shellOverlays.get(id)?.ingest(id, data);
    workers.write(id, data);
    if (bossShellTerminalIds.has(id)) { if (!bossDesktopPreview?.snapshot) bossTerminalScreen(id).write(data, () => { if (bossDesktopPreview?.terminal && bossDesktopPreview.key === id) repaintBossScreen(); }); computer?.refreshDesktopScreen(); }
    const screenOwner = terminalRecords.get(id)?.env?.AGENTOFFICE_PARENT_TERMINAL || (workerDesktops.has(id) ? id : "");
    if (screenOwner) { workers.writeDesktop(screenOwner, id, data); workerDesktops.get(screenOwner)?.refreshDesktopScreen(); }
  });
  api.on("terminal-lifecycle", ({ id, state }: { id: string; state: string }) => {
    if (state === "removed") {
      terminalRecords.delete(id);
      bossShellTerminalIds.delete(id);
      bossTerminalScreens.delete(id);
      overlay.forget(id);
      shellOverlays.get(id)?.forget(id);
      shellOverlays.delete(id);
      const workerDesktop = workerDesktops.get(id);
      if (workerDesktop) { if (workerDesktop.isOpen) workerDesktop.close(); else workerDesktop.detachRoot(); desktopMediaSubscriptions.get(id)?.(); desktopMediaSubscriptions.delete(id); workerDesktops.delete(id); }
      workers.remove(id);
      computer?.refreshSessions();
      void resumes?.refresh();
    } else if (state === "working") workers.setState(id, "working");
    else if (state === "needs_input") workers.setState(id, "needs_input");
    else if (state === "idle" || state === "running") workers.setState(id, "idle");
    else if (state === "done" || state === "exited" || state === "killed" || state === "closed") workers.setState(id, "done");
    else if (state === "error") workers.setState(id, "failed");
    refreshRoster();
  });

  self.id = (await withDeadline(api.connect(), 10000, "the office socket")).connectionId;
  await withDeadline(vehicles.refresh(), 8000, "vehicle state");
  remotes.sync(self.people, self.id);
  refreshRoster();
  api.send("presence_move", { x: player.x, y: player.worldY, z: player.z, yaw: player.facing, seated: player.seated });
  const initialOfficeState = await withDeadline(api.request<OfficeState>("office_state_get"), 8000, "office controls");
  applyOfficeState(initialOfficeState);
  workers.setOfficeClosed(officeClosed);
  if (user.role === "owner") {
    const bannedUsers = () => api.request<User[]>("auth_banned_users").then((users) => hud.setBannedUsers(users));
    const moderate = async (command: string, username: string, refreshBans: boolean) => {
      try {
        await api.request(command, { username });
        if (refreshBans) await bannedUsers();
      } catch (problem) {
        hud.toast(problem instanceof Error ? problem.message : String(problem));
      }
    };
    hud.setModeration(
      (name) => moderate("auth_kick_user", name, false),
      (name) => moderate("auth_ban_user", name, true),
      (name) => moderate("auth_unban_user", name, true),
      (name, nickname) => void api.request("auth_set_nickname", { username: name, nickname }).catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem)))
    );
    refreshRoster();
    await withDeadline(bannedUsers(), 8000, "banned users");
  }
  await withDeadline(board.load(), 8000, "the whiteboard");

  for (const terminal of await api.request<Terminal[]>("list_terminals")) {
    const current = withLocalWorkerIcon(terminal);
    terminalRecords.set(current.id, current);
    workers.adopt(current);
    workers.updateMetadata(current);
    workers.write(current.id, current.backlog);
    overlay.ingest(current.id, current.backlog);
  }
  if (!readOnly) {
    resumes = new ResumeWorkers(api, office, workers, (terminal) => {
      refreshRoster();
      hud.toast(`${terminal.title} returned`);
    }, (message) => hud.toast(message));
    await withDeadline(resumes.restoreAll(), 30000, "saved workers").catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem)));
  }
  if (officeClosed) workers.setOfficeClosed(true);
  refreshRoster();
  if (!readOnly) {
    hud.setPendingGuests(await api.request<User[]>("auth_pending_guests").catch(() => []),
      (name) => api.send("auth_approve_guest", { username: name }),
      (name) => api.send("auth_deny_guest", { username: name }));
  }

  const hireMenu = buildHireMenu(office, async (profile, seat, cwd, icon) => {
    const terminal = await workers.hire(profile, seat, cwd, icon);
    workers.adopt(terminal, seat);
    refreshRoster();
    hud.toast(`${user.displayName} hired ${terminal.title}`);
    overlay.open(terminal);
  });
  computer?.setHireAction((container) => void hireMenu.open(undefined, container));
  const fireWorker = (worker: Worker) => workers.sendHome(worker.terminalId, async () => {
    try {
      const terminals = await api.request<Terminal[]>("list_terminals");
      const personalConsoles = terminals.filter((terminal) => terminal.env?.AGENTOFFICE_PARENT_TERMINAL === worker.terminalId);
      for (const terminal of personalConsoles) await api.request("remove_terminal", { id: terminal.id });
      await api.request("remove_terminal", { id: worker.terminalId });
      workers.remove(worker.terminalId);
      refreshRoster();
      void resumes?.refresh();
      hud.toast(`${worker.name} went home`);
      return true;
    } catch (problem) {
      hud.toast(problem instanceof Error ? problem.message : String(problem));
      return false;
    }
  });
  const fireConfirmation = buildFireConfirmation(fireWorker);
  const sendHome = (worker: Worker) => fireConfirmation.open(worker);
  const saveWorkerMetadata = async (id: string, title: string, icon: string) => {
    await api.request("update_terminal_metadata", { id, patch: isCustomLaptopIcon(icon) ? { title } : { title, icon } });
    localStorage.setItem(workerIconKey(id), icon);
    const terminal = terminalRecords.get(id);
    if (terminal) terminalRecords.set(id, { ...terminal, title, icon });
    workers.all.find((worker) => worker.terminalId === id)?.updateMetadata(title, icon);
  };
  const workerEditor = user.role === "owner" ? buildWorkerEditor(saveWorkerMetadata) : undefined;
  const phone: OfficePhone = new OfficePhone({
    owner: user.role === "owner",
    canReset: !readOnly,
    youtube,
    openWorker: (id) => { const worker = workers.all.find((item) => item.terminalId === id); if (worker) openTerminal(worker); },
    whiteboard: () => board.openEditor(),
    vehicles: () => vehicles.cars,
    drive: (id, arrival) => vehicles.enter(id, arrival),
    weather: () => ({ kind: office.weather.current, season: office.weather.resolvedSeason, daylight: office.weather.daylight }),
    workers: () => workers.all.map((worker) => ({ terminalId: worker.terminalId, name: worker.name, state: worker.state, isLeaving: worker.isLeaving, icon: worker.icon })),
    hire: () => void hireMenu.open(),
    fire: (id) => { const worker = workers.all.find((item) => item.terminalId === id); if (worker) sendHome(worker); },
    edit: saveWorkerMetadata,
    settings: () => settings.getSettings(),
    setSetting: (key, value) => settings.setSetting(key, value),
    resetObjects: () => { office.resetMovableObjects(); if (!readOnly) api.send("props_reset"); hud.toast("Moved objects reset"); },
    unstuck: () => { player.resetToSafePosition(); hud.toast("Position reset"); },
    signOut: () => location.reload(),
    office: () => ({ lightsOn: office.lightOn, lightRows: office.lightRows, stickyNotes: office.stickyNotes, breakroomOn: office.breakroomOn, blindStage: office.blindStage, blindStages: { ...office.blindStages }, season: office.weather.season, wallArt: [...office.wallArt.placements], officeClosed }),
    blindControls: () => office.blindControls.map(({ id, label }) => ({ id, label })),
    updateOffice: (change) => { rememberBlindStages(change); void api.request<OfficeState>("office_state_set", change).then((state) => { applyOfficeState(state); workers.setOfficeClosed(officeClosed); }).catch((problem) => {
      if (typeof change.officeClosed === "boolean") { rememberOfficeClosed(change.officeClosed); return; }
      hud.toast(problem instanceof Error ? problem.message : String(problem));
    }); },
    atDesk: () => atBossDesk()
  }, user.username);
  const dictation = user.role === "owner" ? new Dictation(() => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : hud.chatInput;
  }, (message) => hud.toast(message)) : undefined;
  let xrMode = false;
  let xrTarget: XRTarget | null = null;
  let mouseTarget: XRTarget | null = null, pointedTarget: XRTarget | null = null, pointerAimUpdatedAt = 0;
  const isXRTarget = (kind: XRTarget["kind"]): boolean => xrMode && xrTarget?.kind === kind || mouseTarget?.kind === kind;

  const focus = (): Focus | null => {
    const pointedWorker = mouseTarget?.kind === "worker" ? mouseTarget : xrTarget?.kind === "worker" ? xrTarget : null;
    if (pointedWorker) { const worker = workers.all.find((item) => item.terminalId === pointedWorker.id); return worker ? { kind: "worker", seat: worker.seat, worker } : null; }
    if (!xrMode && mouseTarget && (mouseTarget.kind === "desk" || mouseTarget.kind === "worker-computer")) { const seatId = mouseTarget.seatId, seat = office.seats.find((item) => item.id === seatId); if (!seat) return null; const worker = workers.at(seat.id); return { kind: worker ? "worker" : "seat", seat, worker: worker ?? undefined }; }
    if (xrMode) {
      const target = xrTarget;
      if (target?.kind !== "desk" && target?.kind !== "worker-computer") return null;
      const seat = office.seats.find((item) => item.id === target.seatId);
      if (!seat) return null;
      const worker = workers.at(seat.id);
      return { kind: worker ? "worker" : "seat", seat, worker: worker ?? undefined };
    }
    let best: Focus | null = null, bestDistance = 2.35;
    const yaw = player.yaw + Math.PI, forwardX = Math.sin(yaw), forwardZ = Math.cos(yaw);
    const origin = new THREE.Vector3(player.x, player.worldY + 1.1, player.z), hit = new THREE.Vector3();
    for (const worker of workers.all) {
      if (!worker.onBreak || !worker.figure.root.visible) continue;
      const position = worker.figure.root.position, dx = position.x - player.x, dz = position.z - player.z, distance = Math.hypot(dx, dz);
      if (Math.abs(position.y - player.worldY) > 0.8 || distance > bestDistance || distance < 0.01 || (dx * forwardX + dz * forwardZ) / distance < 0.35) continue;
      const ray = new THREE.Ray(origin, new THREE.Vector3(dx, 0, dz).normalize());
      if (office.tallColliders.some((bounds) => ray.intersectBox(bounds, hit) && hit.distanceTo(origin) < distance - 0.35)) continue;
      bestDistance = distance; best = { kind: "worker", seat: worker.seat, worker };
    }
    for (const seat of office.seats) {
      if (Math.abs(player.worldY) > 0.8) continue;
      const dx = seat.x - player.x, dz = seat.z - player.z, distance = Math.hypot(dx, dz);
      if (distance > bestDistance || distance < 0.01 || (dx * forwardX + dz * forwardZ) / distance < 0.35) continue;
      const ray = new THREE.Ray(origin, new THREE.Vector3(dx, 0, dz).normalize());
      if (office.tallColliders.some((bounds) => ray.intersectBox(bounds, hit) && hit.distanceTo(origin) < distance - 0.35)) continue;
      bestDistance = distance;
      const worker = workers.at(seat.id);
      best = { kind: worker ? "worker" : "seat", seat, worker };
    }
    return best;
  };

  const openWorkerDesktop = (worker: Worker) => {
    let desktop = workerDesktops.get(worker.terminalId);
    if (!desktop) {
      const terminal = terminalRecords.get(worker.terminalId) ?? { id: worker.terminalId, profileId: "codex", title: worker.name, role: worker.role, accent: worker.accent, icon: worker.icon, cwd: "", command: "codex", args: [], env: {}, swarmX: worker.seat.x, swarmY: worker.seat.z, state: "running", activityState: worker.state, backlog: "", mode: "pty", cols: 100, rows: 28 } satisfies Terminal;
      const layer = document.createElement("div");
      let created!: BossComputer;
      created = new BossComputer(api, office, layer, openShellTerminal, () => {}, (message) => hud.toast(message), () => { if (player.seated && Math.hypot(player.x - worker.seat.x, player.z - worker.seat.z) < 1.1) player.stand(); }, () => {}, "worker", terminal, worker.seat, () => { if (activeWorkerDesktop === created) activeWorkerDesktop = undefined; }, (preview) => { workers.setDesktopPreview(worker.terminalId, preview); if (worker.seat.laptop) youtube.setDesktopPreview(preview, worker.seat.laptop.screen); });
      created.setYouTubeHandlers((id, slot) => youtube.play(id, slot, worker.seat.laptop?.screen), (target) => youtube.setTarget(target), () => youtube.stop(), (slot) => youtube.attach(slot, worker.seat.laptop?.screen));
      desktopMediaSubscriptions.set(worker.terminalId, youtube.subscribe((state) => created.syncYouTubePlayback(state)));
      created.setBlindStagesFallbackHandler(rememberBlindStages);
      desktop = created;
      workerDesktops.set(worker.terminalId, desktop);
    }
    if (activeWorkerDesktop && activeWorkerDesktop !== desktop) activeWorkerDesktop.close();
    computer?.detachRoot();
    activeWorkerDesktop = desktop;
    void desktop.open();
  };

  const boardDistance = () => Math.hypot(player.x - office.whiteboardAnchor.x, player.worldY + 1.3 - office.whiteboardAnchor.y, player.z - office.whiteboardAnchor.z);
  const atBoard = () => isXRTarget("board") || !xrMode && boardDistance() < 3.4;
  const atElevator = () => isXRTarget("elevator") || !xrMode && (Math.hypot(player.x - office.elevator.position.x, player.z - office.elevator.position.z) < 1.5 || Math.hypot(player.x - office.elevator.carPosition.x, player.z - office.elevator.carPosition.z) < 1.15);
  const atExitDoor = () => isXRTarget("exit") || !xrMode && office.isNearExitDoor(player.x, player.z);
  const stickyNoteAt = () => {
    let closest = -1, distance = 1.05;
    for (let i = 0; i < office.stickyNotePositions.length; i++) {
      const p = office.stickyNotePositions[i];
      if (!p) continue;
      const next = Math.hypot(player.x - p.x, player.z - p.z);
      if (next < distance) { closest = i; distance = next; }
    }
    return closest;
  };
  const atBossDesk = () => user.role === "owner" && (isXRTarget("boss-computer") || !xrMode && Math.abs(player.worldY - office.bossSeat.y) < 1 && Math.hypot(player.x - office.bossSeat.x, player.z - office.bossSeat.z) < 2.2);
  const atWatercooler = () => isXRTarget("watercooler") || !xrMode && Math.abs(player.worldY) < 0.8 && Math.hypot(player.x - office.watercoolerPosition.x, player.z - office.watercoolerPosition.z) < 1.3;
  const atBreakroomSwitch = () => isXRTarget("breakroom-switch") || !xrMode && Math.abs(player.worldY) < 0.8 && Math.hypot(player.x - office.breakroomSwitchPosition.x, player.z - office.breakroomSwitchPosition.z) < 0.82;
  const lightRowSwitchAt = () => {
    if (mouseTarget?.kind === "light-row") return mouseTarget.index;
    if (xrMode) return xrTarget?.kind === "light-row" ? xrTarget.index : -1;
    let closest = -1, distance = 0.82;
    for (let i = 0; i < office.lightRowSwitchPositions.length; i++) {
      const p = office.lightRowSwitchPositions[i], next = Math.hypot(player.x - p.x, player.z - p.z);
      if (next < distance) { closest = i; distance = next; }
    }
    return closest;
  };
  const blindControlAt = (): string => {
    if (mouseTarget?.kind === "blind-control") return mouseTarget.id;
    if (xrMode) return xrTarget?.kind === "blind-control" ? xrTarget.id : "";
    let closest = "", distance = 1.25;
    for (const control of office.blindControls) { const next = Math.hypot(player.x - control.x, player.z - control.z); if (next < distance) { closest = control.id; distance = next; } }
    return closest;
  };
  const changeOffice = (change: Partial<OfficeState>) => { rememberBlindStages(change); return void api.request<OfficeState>("office_state_set", change)
    .then(applyOfficeState).catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem)));
  };
  const stickyNoteEditor = new StickyNoteEditor(readOnly, (index, text) => {
    const stickyNotes = [...office.stickyNotes];
    stickyNotes[index] = text;
    changeOffice({ stickyNotes });
  });
  let stickyNotePlacement = -1;
  let ridingElevator = false;
  let wallAimRay = (): THREE.Ray => {
    office.camera.updateMatrixWorld(true);
    const origin = new THREE.Vector3(), direction = new THREE.Vector3();
    office.camera.getWorldPosition(origin); office.camera.getWorldDirection(direction);
    return new THREE.Ray(origin, direction);
  };

  const openTerminal = (worker: Worker) => {
    overlay.open({
      id: worker.terminalId, profileId: "", title: worker.name, role: worker.role, accent: worker.accent,
      cwd: "", command: "", args: [], state: worker.state, backlog: "", mode: "pty", cols: 100, rows: 28
    });
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    const targetElement = event.target instanceof HTMLElement ? event.target : null;
    const editing = targetElement?.matches("input,textarea,.xterm-helper-textarea,[contenteditable=true]") ?? false;
    if (stickyNoteEditor.isOpen) {
      if (event.key === "Escape") { event.preventDefault(); stickyNoteEditor.close(); }
      return;
    }
    if (key === "escape" && stickyNotePlacement >= 0) { stickyNotePlacement = -1; office.setStickyNotePreview(null); event.preventDefault(); return; }
    if (key === "escape" && office.wallArt.active) { office.wallArt.cancel(); event.preventDefault(); return; }
    if (workerEditor?.isOpen) {
      if (event.key === "Escape") { event.preventDefault(); workerEditor.close(); }
      return;
    }
    if (fireConfirmation.isOpen) {
      if (event.key === "Escape") { event.preventDefault(); fireConfirmation.close(); }
      return;
    }
    if (phone?.isOpen && event.key === "Escape") { event.preventDefault(); phone.close(); return; }
    if (computer?.isOpen && event.key === "Escape") {
      event.preventDefault();
      computer.close();
      return;
    }
    if (activeWorkerDesktop?.isOpen && event.key === "Escape") { event.preventDefault(); activeWorkerDesktop.close(); return; }
    if (overlay.blocksOfficeInput) return;
    if (board.isOpen) {
      if (event.key === "Escape") board.closeEditor();
      return;
    }
    if (phone?.isOpen || computer?.isOpen || activeWorkerDesktop?.isOpen || editing) return;
    if (vehicles.driving.active && vehicles.driving.handleKey(event, true)) return;
    if (key === "q") {
      event.preventDefault();
      const target = focus();
      if (!readOnly && target?.kind === "seat" && !target.worker) void hireMenu.open(target.seat);
      else if (!readOnly && atBossDesk()) void hireMenu.open();
      return;
    }
    if (key === "f") {
      if (readOnly) return;
      if (office.coffee.hasCup) { event.preventDefault(); hud.toast(office.coffee.drop(player.x, player.z, player.worldY, player.facing) ? "Cup put down" : "No clear place to put the cup"); return; }
      const result = office.toggleHeldObject(player.x, player.z);
      if (result.position) api.send("prop_move", { prop: result.position });
      if (result.action !== "none") hud.toast(result.action === "picked" ? "Picked up" : result.action === "blocked" ? "No room to drop it" : "Dropped");
      return;
    }
    const target = focus();
    if (key === "e" && !readOnly && stickyNotePlacement < 0 && !office.wallArt.active) {
      if (office.coffee.hasCup || isXRTarget("coffee") || isXRTarget("bin") || office.coffee.nearMachine(player.x, player.z, player.worldY) || office.coffee.nearCup(player.x, player.z, player.worldY)) {
        const previous = office.coffee.state, message = office.coffee.interact(player.x, player.z, player.worldY);
        if (message) { event.preventDefault(); player.reach(); hud.toast(message); if (previous !== "brewing" && office.coffee.state === "brewing") void audio.unlock().then(() => audio.playCoffee()); return; }
      }
      const pointed = mouseTarget?.kind === "vehicle" ? mouseTarget : xrTarget?.kind === "vehicle" ? xrTarget : null, car = pointed ? vehicles.driving.cars.find((item) => item.id === pointed.id) : vehicles.driving.nearest(player.x, player.z, player.worldY);
      if (car) { event.preventDefault(); if (!event.repeat) void vehicles.enter(car.id).catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem))); return; }
    }
    if (key === "t") { event.preventDefault(); if (target?.worker) openTerminal(target.worker); return; }
    if (key === "b") { event.preventDefault(); hud.chatInput.focus(); return; }
    if (key === "c" && user.role === "owner" && target?.worker) { event.preventDefault(); openWorkerDesktop(target.worker); return; }
    if (key === "n" && !readOnly && target?.worker) {
      event.preventDefault();
      workerEditor?.open(target.worker);
      return;
    }
    if (key === "n" && !readOnly && !target?.worker) {
      event.preventDefault();
      const empty = office.stickyNotes.findIndex((value) => {
        if (!value.trim()) return true;
        try { const note = JSON.parse(value); return !String(note.text ?? "").trim() && !(Array.isArray(note.strokes) && note.strokes.length); } catch { return false; }
      });
      if (empty < 0) hud.toast("All sticky-note spaces are in use");
      else { stickyNotePlacement = empty; office.setStickyNotePreview(office.aimWall(wallAimRay())); }
      return;
    }
    if (key === "h" && !readOnly) { event.preventDefault(); void office.wallArt.begin(); return; }
    if (key === "r" && officeDog.isNear(player.x, player.z, player.worldY)) {
      player.reach();
      hud.toast(officeDog.commandRest() ? "Milo is heading to his bed" : "Milo is up");
      return;
    }
    if (key === "e" && (isXRTarget("dog") || !xrMode && officeDog.isNear(player.x, player.z, player.worldY))) {
      player.reach();
      officeDog.pet(player.x, player.z);
      audio.playDog();
      api.send("dog_pet");
      return;
    }
    if (key === "e" && stickyNotePlacement >= 0) {
      const point = office.aimWall(wallAimRay());
      if (!point) { hud.toast("Aim at a solid wall to place the sticky note"); return; }
      const index = stickyNotePlacement; stickyNotePlacement = -1; office.setStickyNotePreview(null); stickyNoteEditor.open(index, "", point); return;
    }
    if (key === "e" && office.wallArt.active) {
      player.reach();
      const picture = office.wallArt.place();
      if (!picture) { hud.toast("Aim at an open part of a wall to hang the picture"); return; }
      changeOffice({ wallArt: [...office.wallArt.placements, picture] }); return;
    }
    if (key === "e") player.reach();
    if (key === "c" && atBossDesk()) {
      void computer?.open();
      return;
    }
    if (key === "e" && atBossDesk()) {
      if (player.seated) void computer?.open(); else player.sit(office.bossSeat);
      return;
    }
    if (key === "e" && atElevator() && !office.elevator.moving) {
      const playerFloor = office.elevator.walkSurfaces.reduce((nearest, surface) => Math.abs(player.worldY - surface.height) < Math.abs(player.worldY - nearest) ? surface.height : nearest, office.elevator.walkSurfaces[0].height);
      const insideElevator = Math.abs(player.x - office.elevator.carPosition.x) < 0.9 && Math.abs(player.z - office.elevator.carPosition.z) < 1.1 && Math.abs(player.worldY - office.elevator.carY) < 0.45;
      if (insideElevator && office.elevator.currentFloor === playerFloor) {
        ridingElevator = true;
        void office.elevator.ride().then(() => { ridingElevator = false; }).catch((problem) => { ridingElevator = false; hud.toast(problem instanceof Error ? problem.message : String(problem)); });
      } else if (office.elevator.currentFloor !== playerFloor) {
        void office.elevator.ride().catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem)));
      }
      return;
    }
    if (key === "e" && atExitDoor()) {
      office.toggleExitDoor();
      return;
    }
    if (key === "e" && atWatercooler()) {
      office.useWatercooler();
      hud.toast("Water break");
      return;
    }
    if (key === "e" && !readOnly && atBreakroomSwitch()) {
      changeOffice({ breakroomOn: !office.breakroomOn });
      return;
    }
    const stickyNote = stickyNoteAt();
    if (key === "e" && stickyNote >= 0) {
      stickyNoteEditor.open(stickyNote, office.stickyNotes[stickyNote] ?? "");
      return;
    }
    const lightRow = lightRowSwitchAt();
    if (key === "e" && !readOnly && lightRow >= 0) {
      const lightRows = [...office.lightRows] as [boolean, boolean, boolean];
      lightRows[lightRow] = !lightRows[lightRow];
      changeOffice({ lightRows });
      return;
    }
    const blindId = blindControlAt();
    if (key === "e" && !readOnly && blindId) {
      const blindStages = { ...office.blindStages };
      const blindStage = ((blindStages[blindId] ?? office.blindStage) + 1) % 3;
      blindStages[blindId] = blindStage;
      changeOffice({ blindStage, blindStages });
      return;
    }
    if (key === "e" && atBoard()) {
      board.openEditor();
      return;
    }
    if (key === "e") {
      if (player.seated) { player.stand(); return; }
      const roomSeat = office.roomSeatAt(player.x, player.z), targetDistance = target?.kind === "seat" ? Math.hypot(player.x - target.seat.x, player.z - target.seat.z) : Infinity, roomDistance = roomSeat ? Math.hypot(player.x - roomSeat.x, player.z - roomSeat.z) : Infinity;
      if (roomSeat && roomDistance < targetDistance) player.sit(roomSeat);
      else if (target?.kind === "seat" && !target.worker) player.sit(target.seat);
    }
    if (key === "g" && target?.worker && !readOnly) sendHome(target.worker);
    if (key === "escape") {
      overlay.close();
      hireMenu.close();
      board.closeEditor();
    }
  };
  addEventListener("keydown", handleKeyDown);
  addEventListener("keyup", (event) => { vehicles.driving.handleKey(event, false); });
  addEventListener("blur", () => vehicles.driving.clearInput());

  hud.onChat((text) => {
    if (!text) return false;
    api.send("chat_send", { text });
    return true;
  });

  office.resize();
  addEventListener("resize", () => {
    office.resize();
    board.onResize();
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const canvas = office.renderer.domElement;
  let drawingOnWall = false;
  const wallPoint = (event: PointerEvent, begin: boolean): void => {
    pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, office.camera);
    const point = board.fromRay(raycaster);
    if (point) board.strokeOnWall(point, begin);
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !event.ctrlKey) player.reach();
    if (computer && atBossDesk() && event.button === 0) {
      pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
      raycaster.setFromCamera(pointer, office.camera);
      if (raycaster.intersectObject(office.bossLaptop.base, true).length) {
        void computer.open();
        return;
      }
    }
    if (board.isOpen || !board.canDraw || !atBoard() || !event.ctrlKey) return;
    drawingOnWall = true;
    wallPoint(event, true);
  });
  canvas.addEventListener("pointermove", (event) => drawingOnWall && wallPoint(event, false));
  addEventListener("pointerup", () => {
    if (drawingOnWall) board.endStroke();
    drawingOnWall = false;
  });

  const vrButton = document.createElement("button");
  vrButton.id = "vr-enter";
  vrButton.type = "button";
  vrButton.textContent = "Enter VR";
  vrButton.hidden = true;
  (document.getElementById("toolbar") ?? document.body).append(vrButton);
  const xrSystem = navigator.xr;
  let xrSession: XRSession | null = null;
  xrOverlay.addEventListener("beforexrselect", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button,input,textarea,select,a,[contenteditable='true'],[role='button'],dialog,canvas,.desktop-app-window,.desktop-app-titlebar,.pc-titlebar,.xterm,[data-xr-interactive]")) event.preventDefault();
  });
  void supportsImmersiveVR(xrSystem).then((supported) => { vrButton.hidden = !supported; });

  const hitboxGroup = new THREE.Group();
  hitboxGroup.name = "vr-interaction-zones";
  office.scene.add(hitboxGroup);
  const hitboxMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
  const vrTargets: THREE.Object3D[] = [hitboxGroup];
  const workerPointTargets = new Map<string, THREE.Object3D>();
  const tagVRTarget = (object: THREE.Object3D, target: XRTarget): void => { object.userData.vrTarget = target; vrTargets.push(object); };
  const addVRHitbox = (target: XRTarget, x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0): THREE.Object3D => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), hitboxMaterial);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    mesh.frustumCulled = false;
    mesh.userData.vrTarget = target;
    hitboxGroup.add(mesh);
    return mesh;
  };
  const xrWorldPanel = new THREE.Group();
  const xrPanelCanvas = document.createElement("canvas");
  xrPanelCanvas.width = 1024;
  xrPanelCanvas.height = 600;
  const xrPanelContext = xrPanelCanvas.getContext("2d")!;
  const xrPanelTexture = new THREE.CanvasTexture(xrPanelCanvas);
  xrPanelTexture.colorSpace = THREE.SRGBColorSpace;
  xrWorldPanel.add(new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.68), new THREE.MeshBasicMaterial({ map: xrPanelTexture, side: THREE.DoubleSide, depthWrite: false })));
  xrWorldPanel.visible = false;
  office.scene.add(xrWorldPanel);
  const addXRPanelButton = (label: string, color: string, action: "lights" | "breakroom" | "office", x: number): void => {
    const buttonCanvas = document.createElement("canvas");
    buttonCanvas.width = 512;
    buttonCanvas.height = 160;
    const context = buttonCanvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(8, 8, 496, 144);
    context.strokeStyle = "#fff0d0";
    context.lineWidth = 8;
    context.strokeRect(8, 8, 496, 144);
    context.fillStyle = "#ffffff";
    context.font = "bold 40px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, 256, 80, 450);
    const texture = new THREE.CanvasTexture(buttonCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const button = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.105), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, depthWrite: false }));
    button.position.set(x, -0.22, 0.02);
    button.userData.vrTarget = { kind: "world-action", action } satisfies XRTarget;
    xrWorldPanel.add(button);
    vrTargets.push(button);
  };
  if (user.role === "owner") { addXRPanelButton("Toggle lights", "#2f6fd0", "lights", -0.38); addXRPanelButton("Break room lights", "#d18a63", "breakroom", 0); addXRPanelButton("Office day", "#2f9e5f", "office", 0.38); }
  let xrPanelSignature = "";
  const refreshXRWorldPanel = (): void => {
    const targetName = xrTarget?.kind === "worker-computer" ? "Agent computer" : xrTarget?.kind === "boss-computer" ? "Office computer" : xrTarget?.kind === "desk" ? "Desk" : xrTarget?.kind === "exit" ? "Exit door" : xrTarget?.kind === "elevator" ? "Elevator" : xrTarget?.kind === "dog" ? "Milo" : xrTarget?.kind === "light-row" ? "Office lights" : xrTarget?.kind === "blind-control" ? office.blindControls.find((control) => control.id === (xrTarget as Extract<XRTarget, { kind: "blind-control" }>).id)?.label ?? "Window shade" : xrTarget?.kind === "board" ? "Whiteboard" : xrTarget?.kind === "watercooler" ? "Water cooler" : xrTarget?.kind === "breakroom-switch" ? "Break room lights" : "Nothing aimed at";
    const signature = `${targetName}|${office.lightOn}|${office.breakroomOn}|${officeClosed}`;
    if (signature === xrPanelSignature) return;
    xrPanelSignature = signature;
    xrPanelContext.clearRect(0, 0, xrPanelCanvas.width, xrPanelCanvas.height);
    xrPanelContext.fillStyle = "#142a40";
    xrPanelContext.fillRect(0, 0, 1024, 600);
    xrPanelContext.fillStyle = "#f6e7c8";
    xrPanelContext.fillRect(10, 10, 1004, 580);
    xrPanelContext.fillStyle = "#20384f";
    xrPanelContext.fillRect(10, 10, 1004, 105);
    xrPanelContext.fillStyle = "#ffffff";
    xrPanelContext.font = "bold 42px system-ui, sans-serif";
    xrPanelContext.fillText("OFFICE · VR CONTROLS", 42, 76);
    xrPanelContext.fillStyle = "#3f3427";
    xrPanelContext.font = "30px system-ui, sans-serif";
    xrPanelContext.fillText(`Aimed at: ${targetName}`, 42, 190);
    xrPanelContext.font = "26px system-ui, sans-serif";
    xrPanelContext.fillText("Point a controller ray at a desk, door, switch, elevator or Milo", 42, 265);
    xrPanelContext.fillText("Squeeze trigger to interact · Left stick move · Right stick snap turn", 42, 325);
    if (user.role === "owner") {
      xrPanelContext.fillText(`Office lights: ${office.lightOn ? "on" : "off"}     Break room: ${office.breakroomOn ? "on" : "off"}`, 42, 405);
      xrPanelContext.fillText(`Office: ${officeClosed ? "closed" : "open"}`, 42, 445);
      xrPanelContext.fillText("Use the buttons below for room lights and office-day controls", 42, 495);
    } else xrPanelContext.fillText("Use the controller trigger to interact with the aimed object", 42, 405);
    xrPanelTexture.needsUpdate = true;
  };
  for (const seat of office.seats) {
    const target: XRTarget = { kind: "desk", seatId: seat.id };
    tagVRTarget(seat.chair, target);
    tagVRTarget(seat.marker, target);
    if (seat.laptop) { const computerTarget: XRTarget = { kind: "worker-computer", seatId: seat.id }; tagVRTarget(seat.laptop.base, computerTarget); tagVRTarget(seat.laptop.screen, computerTarget); }
    addVRHitbox(target, seat.x, 0.92, seat.z - 0.35, 1.8, 0.58, 1.55, seat.yaw);
  }
  tagVRTarget(office.bossLaptop.base, { kind: "boss-computer" });
  tagVRTarget(office.bossLaptop.screen, { kind: "boss-computer" });
  addVRHitbox({ kind: "boss-computer" }, office.bossSeat.x, 4.18, office.bossSeat.z - 1.05, 1.75, 0.9, 1.1, office.bossSeat.yaw);
  tagVRTarget(officeDog.root, { kind: "dog" });
  addVRHitbox({ kind: "exit" }, office.exitDoorPosition.x + 0.32, 1.18, office.exitDoorPosition.z, 0.22, 2.35, 1.38);
  addVRHitbox({ kind: "elevator" }, office.elevator.position.x, 1.15, office.elevator.position.z, 2.2, 2.25, 0.48);
  addVRHitbox({ kind: "elevator" }, office.elevator.carPosition.x, office.elevator.carY + 1.15, office.elevator.carPosition.z + 1.05, 1.45, 2.25, 0.25);
  for (let i = 0; i < office.lightRowSwitchPositions.length; i++) { const p = office.lightRowSwitchPositions[i]; addVRHitbox({ kind: "light-row", index: i }, p.x, 1.26, p.z, 0.32, 0.36, 0.22); }
  addVRHitbox({ kind: "breakroom-switch" }, office.breakroomSwitchPosition.x, office.breakroomSwitchPosition.y, office.breakroomSwitchPosition.z, 0.18, 0.38, 0.3);
  for (const control of office.blindControls) addVRHitbox({ kind: "blind-control", id: control.id }, control.x, control.y, control.z, 0.18, 0.7, 0.18);
  addVRHitbox({ kind: "watercooler" }, office.watercoolerPosition.x, 0.95, office.watercoolerPosition.z, 0.8, 1.5, 0.8);
  addVRHitbox({ kind: "coffee" }, office.coffee.machinePosition.x, office.coffee.machinePosition.y + 0.32, office.coffee.machinePosition.z, 0.52, 0.66, 0.46);
  addVRHitbox({ kind: "bin" }, office.coffee.binPosition.x, 0.35, office.coffee.binPosition.z, 0.54, 0.7, 0.54);
  const vehicleHitboxes = vehicles.driving.cars.map((car) => ({ car, box: addVRHitbox({ kind: "vehicle", id: car.id }, car.root.position.x, car.root.position.y + 0.8, car.root.position.z, 1.92, 1.65, 3.7, car.root.rotation.y) }));
  addVRHitbox({ kind: "board" }, office.whiteboardAnchor.x, office.whiteboardAnchor.y, office.whiteboardAnchor.z, 4.2, 2.2, 0.28);

  const vrRaycaster = new THREE.Raycaster();
  vrRaycaster.far = 6;
  const vrScratch = new THREE.Vector3();
  const xrOrientationScratch = new THREE.Quaternion();
  const controllerBySource = new Map<XRInputSource, ReturnType<typeof office.renderer.xr.getController>>();
  const xrTriggerStates = new Map<XRInputSource, boolean>();
  const controllers = [0, 1].map((index) => {
    const controller = office.renderer.xr.getController(index);
    const grip = office.renderer.xr.getControllerGrip(index);
    controller.visible = false;
    grip.visible = false;
    const shell = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.065, 0.13), new THREE.MeshBasicMaterial({ color: 0x263545 }));
    shell.position.set(0, 0.005, 0.035);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.043, 0.14, 8), new THREE.MeshBasicMaterial({ color: 0x111a24 }));
    handle.position.set(0, -0.082, 0.065);
    handle.rotation.x = 0.18;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), new THREE.MeshBasicMaterial({ color: index ? 0xffbf68 : 0x73d9ff }));
    face.position.set(index ? 0.027 : -0.027, 0.04, 0.015);
    grip.add(shell, handle, face);
    controller.addEventListener("connected", (event) => { controllerBySource.set(event.data, controller); xrTriggerStates.set(event.data, false); controller.userData.xrInputSource = event.data; controller.visible = true; grip.visible = true; });
    controller.addEventListener("disconnected", (event) => { controllerBySource.delete(event.data); xrTriggerStates.delete(event.data); delete controller.userData.xrInputSource; controller.visible = false; grip.visible = false; });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: index ? 0xffd27a : 0x85d9ff, transparent: true, opacity: 0.88 }));
    line.frustumCulled = false;
    line.scale.z = 5;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    dot.visible = false;
    controller.add(line, dot);
    office.cameraRig.add(controller, grip);
    return { controller, grip, line, dot };
  });
  const controllerWallRay = (controller: THREE.Object3D): THREE.Ray => {
    controller.updateMatrixWorld(true);
    const origin = new THREE.Vector3(), rotation = new THREE.Quaternion(), direction = new THREE.Vector3(0, 0, -1);
    controller.getWorldPosition(origin); controller.getWorldQuaternion(rotation); direction.applyQuaternion(rotation);
    return new THREE.Ray(origin, direction);
  };
  wallAimRay = () => {
    const controller = xrMode ? controllers.find((item) => item.controller.visible)?.controller : undefined;
    if (controller) return controllerWallRay(controller);
    office.camera.updateMatrixWorld(true);
    const origin = new THREE.Vector3(), direction = new THREE.Vector3(); office.camera.getWorldPosition(origin); office.camera.getWorldDirection(direction);
    return new THREE.Ray(origin, direction);
  };
  const findVRTarget = (controller: ReturnType<typeof office.renderer.xr.getController>): { target: XRTarget | null; distance: number } => {
    office.cameraRig.updateMatrixWorld(true);
    controller.updateMatrixWorld(true);
    vrRaycaster.setFromXRController(controller);
    const hit = vrRaycaster.intersectObjects(vrTargets, true)[0];
    let distance = hit?.distance ?? 5;
    if (!hit) return { target: null, distance };
    for (const bounds of office.tallColliders) {
      const blocked = vrRaycaster.ray.intersectBox(bounds, vrScratch);
      if (!blocked) continue;
      const blockDistance = blocked.distanceTo(vrRaycaster.ray.origin);
      if (blockDistance < hit.distance - 0.14) return { target: null, distance: blockDistance };
      distance = Math.min(distance, blockDistance);
    }
    let object: THREE.Object3D | null = hit.object;
    while (object && !object.userData.vrTarget) object = object.parent;
    return { target: (object?.userData.vrTarget as XRTarget | undefined) ?? null, distance: hit.distance };
  };
  const findPointedTarget = (): XRTarget | null => {
    office.cameraRig.updateMatrixWorld(true); hitboxGroup.updateMatrixWorld(true); officeDog.root.updateMatrixWorld(true);
    vrRaycaster.setFromCamera(new THREE.Vector2(0, 0), office.camera);
    const hit = vrRaycaster.intersectObjects(vrTargets, true)[0];
    if (!hit || hit.distance > 4) return null;
    for (const bounds of office.tallColliders) { const blocked = vrRaycaster.ray.intersectBox(bounds, vrScratch); if (blocked && blocked.distanceTo(vrRaycaster.ray.origin) < hit.distance - 0.14) return null; }
    let object: THREE.Object3D | null = hit.object;
    while (object && !object.userData.vrTarget) object = object.parent;
    return (object?.userData.vrTarget as XRTarget | undefined) ?? null;
  };
  const canPointInteract = (target: XRTarget): boolean => (target.kind !== "boss-computer" || user.role === "owner") && (!readOnly || !["breakroom-switch", "light-row", "blind-control", "coffee", "bin", "vehicle"].includes(target.kind));
  const interactPointed = (event: PointerEvent): void => {
    const canvas = office.renderer.domElement;
    if (xrMode || event.button !== 0 || document.pointerLockElement !== canvas) return;
    if (stickyNotePlacement >= 0 || office.wallArt.active) { event.preventDefault(); handleKeyDown(new KeyboardEvent("keydown", { key: "e", code: "KeyE" })); return; }
    const target = findPointedTarget();
    if (!target || !canPointInteract(target)) return;
    event.preventDefault();
    if (target.kind === "worker-computer") { const worker = workers.at(target.seatId); if (!worker) return; player.reach(); if (user.role === "owner") openWorkerDesktop(worker); else openTerminal(worker); return; }
    mouseTarget = target;
    const key = target.kind === "worker" ? "t" : "e";
    try { handleKeyDown(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}` })); } finally { mouseTarget = null; }
  };
  office.renderer.domElement.addEventListener("pointerdown", interactPointed);
  const updateVRTargets = (): void => {
    for (const worker of workers.all) if (worker.figure.root.visible && !workerPointTargets.has(worker.terminalId)) { workerPointTargets.set(worker.terminalId, worker.figure.root); tagVRTarget(worker.figure.root, { kind: "worker", id: worker.terminalId }); }
    for (const [id, root] of workerPointTargets) if (!root.parent || !root.visible) { const index = vrTargets.indexOf(root); if (index >= 0) vrTargets.splice(index, 1); workerPointTargets.delete(id); }
    for (const { car, box } of vehicleHitboxes) { box.position.copy(car.root.position); box.position.y += 0.8; box.rotation.y = car.root.rotation.y; }
    if (!xrMode) { xrTarget = null; return; }
    office.cameraRig.updateMatrixWorld(true);
    hitboxGroup.updateMatrixWorld(true);
    officeDog.root.updateMatrixWorld(true);
    let rightTarget: XRTarget | null = null, fallbackTarget: XRTarget | null = null;
    for (const { controller, line, dot } of controllers) {
      const source = controller.userData.xrInputSource as XRInputSource | undefined;
      if (!controller.visible || !source) continue;
      const result = findVRTarget(controller);
      line.scale.z = Math.max(0.05, result.distance);
      dot.visible = result.target !== null;
      dot.position.set(0, 0, -result.distance);
      if (result.target?.kind === "world-action") continue;
      if (source.handedness === "right") rightTarget = result.target;
      else if (!fallbackTarget) fallbackTarget = result.target;
    }
    xrTarget = rightTarget ?? fallbackTarget;
    const carZone = hitboxGroup.children.find((object) => object.userData.vrTarget?.kind === "elevator" && Math.abs(object.position.z - office.elevator.carPosition.z - 1.05) < 0.01);
    if (carZone) carZone.position.y = office.elevator.carY + 1.15;
  };
  const activateXRSource = (source: XRInputSource): void => {
    if (!xrMode) return;
    const controller = controllerBySource.get(source) ?? controllers.find((item) => item.controller.userData.xrInputSource === source)?.controller;
    if (stickyNotePlacement >= 0) {
      player.reach();
      const point = office.aimWall(controller ? controllerWallRay(controller) : wallAimRay());
      if (!point) return hud.toast("Aim at a solid wall to place the sticky note");
      const index = stickyNotePlacement; stickyNotePlacement = -1; office.setStickyNotePreview(null); stickyNoteEditor.open(index, "", point); return;
    }
    if (office.wallArt.active) {
      player.reach();
      office.wallArt.update(controller ? controllerWallRay(controller) : wallAimRay());
      const picture = office.wallArt.place();
      if (!picture) return hud.toast("Aim at an open part of a wall to hang the picture");
      changeOffice({ wallArt: [...office.wallArt.placements, picture] }); return;
    }
    const target = controller ? findVRTarget(controller).target : xrTarget;
    if (target?.kind === "world-action") {
      if (target.action === "lights") changeOffice({ lightsOn: !office.lightOn });
      else if (target.action === "breakroom") changeOffice({ breakroomOn: !office.breakroomOn });
      else { const closed = !officeClosed; rememberOfficeClosed(closed); changeOffice({ officeClosed: closed }); }
      return;
    }
    if (!target) return;
    xrTarget = target;
    player.reach();
    const key = target.kind === "worker" ? "t" : target.kind === "worker-computer" && user.role === "owner" ? "c" : "e";
    handleKeyDown(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}` }));
  };
  const xrPanelViewerPosition = new THREE.Vector3(), xrPanelOffset = new THREE.Vector3(0, -0.18, -1.12), xrPanelWorldOffset = new THREE.Vector3();
  const xrPanelRigQuaternion = new THREE.Quaternion(), xrPanelPoseQuaternion = new THREE.Quaternion(), xrPanelWorldQuaternion = new THREE.Quaternion();
  const updateXRWorldPanel = (frame?: XRFrame): void => {
    if (!xrWorldPanel.visible || !frame) return;
    const referenceSpace = office.renderer.xr.getReferenceSpace(), pose = referenceSpace ? frame.getViewerPose(referenceSpace) : null;
    if (!pose) return;
    office.cameraRig.updateMatrixWorld(true);
    const position = pose.transform.position, orientation = pose.transform.orientation;
    xrPanelViewerPosition.set(position.x, position.y, position.z).applyMatrix4(office.cameraRig.matrixWorld);
    xrPanelRigQuaternion.setFromRotationMatrix(office.cameraRig.matrixWorld);
    xrPanelPoseQuaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    xrPanelWorldQuaternion.copy(xrPanelRigQuaternion).multiply(xrPanelPoseQuaternion);
    xrPanelWorldOffset.copy(xrPanelOffset).applyQuaternion(xrPanelWorldQuaternion);
    xrWorldPanel.position.copy(xrPanelViewerPosition).add(xrPanelWorldOffset);
    xrWorldPanel.quaternion.copy(xrPanelWorldQuaternion);
    xrWorldPanel.updateMatrixWorld(true);
    refreshXRWorldPanel();
  };
  const applyDeadzone = (x: number, y: number): { x: number; y: number } => {
    const length = Math.hypot(x, y);
    if (length < 0.16) return { x: 0, y: 0 };
    const magnitude = Math.min(1, (length - 0.16) / 0.84);
    return { x: x / length * magnitude, y: y / length * magnitude };
  };
  let snapTurnArmed = true;
  let lastSnapTurn = 0;
  const updateXRMovement = (frame?: XRFrame): void => {
    if (!xrMode || !xrSession) { player.setXRMoveInput(0, 0, player.yaw); return; }
    let moveX = 0, moveY = 0, turnX = 0;
    for (const source of xrSession.inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad) continue;
      const axisZero = Math.hypot(gamepad.axes[0] ?? 0, gamepad.axes[1] ?? 0), axisTwo = Math.hypot(gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0);
      const hasXRThumbstick = gamepad.mapping === "xr-standard" || source.profiles.some((profile) => profile.includes("thumbstick") || profile.includes("oculus-touch"));
      const axis = gamepad.axes.length >= 4 ? hasXRThumbstick ? axisTwo > 0.01 || axisZero < 0.16 ? 2 : 0 : axisTwo > axisZero + 0.04 ? 2 : 0 : 0;
      const triggerPressed = gamepad.buttons[0]?.pressed ?? false, wasPressed = xrTriggerStates.get(source) ?? false;
      if (!xrSession.domOverlayState && triggerPressed && !wasPressed) activateXRSource(source);
      xrTriggerStates.set(source, triggerPressed);
      if (source.handedness === "left") { moveX = gamepad.axes[axis] ?? 0; moveY = gamepad.axes[axis + 1] ?? 0; }
      if (source.handedness === "right") turnX = gamepad.axes[axis] ?? 0;
    }
    const move = applyDeadzone(moveX, moveY);
    const right = applyDeadzone(turnX, 0).x;
    const referenceSpace = office.renderer.xr.getReferenceSpace(), pose = frame && referenceSpace ? frame.getViewerPose(referenceSpace) : null;
    const orientation = pose?.transform.orientation;
    let headYaw = player.yaw;
    if (orientation) { vrScratch.set(0, 0, -1).applyQuaternion(xrOrientationScratch.set(orientation.x, orientation.y, orientation.z, orientation.w)); headYaw += Math.atan2(-vrScratch.x, -vrScratch.z); }
    player.setXRMoveInput(-move.y, move.x, headYaw);
    if (Math.abs(right) < 0.2) snapTurnArmed = true;
    else if (snapTurnArmed && Math.abs(right) > 0.68 && performance.now() - lastSnapTurn > 240) {
      player.snapTurn(-Math.sign(right) * Math.PI / 6);
      lastSnapTurn = performance.now();
      snapTurnArmed = false;
    }
  };
  const endXR = (): void => {
    xrMode = false;
    xrSession = null;
    xrTarget = null;
    xrWorldPanel.visible = false;
    xrTriggerStates.clear();
    player.setXRMode(false);
    office.resize();
    for (const item of controllers) { item.controller.visible = false; item.grip.visible = false; }
    document.body.classList.remove("vr-mode");
    vrButton.textContent = "Enter VR";
  };
  const handleXRSelect = (event: XRInputSourceEvent): void => {
    if (!xrMode) return;
    if (event.inputSource.gamepad && !xrSession?.domOverlayState) return;
    activateXRSource(event.inputSource);
  };
  vrButton.addEventListener("click", () => {
    if (xrSession) { void xrSession.end().catch((problem) => hud.toast(problem instanceof Error ? problem.message : String(problem))); return; }
    if (!xrSystem) return;
    let request: Promise<XRSession>;
    try { request = xrSystem.requestSession("immersive-vr", { requiredFeatures: ["local-floor"], optionalFeatures: ["bounded-floor", "dom-overlay"], domOverlay: { root: xrOverlay } }); }
    catch (problem) { hud.toast(problem instanceof Error ? problem.message : "VR session could not start"); return; }
    void request.then(async (session) => {
      xrSession = session;
      session.addEventListener("end", endXR, { once: true });
      session.addEventListener("select", handleXRSelect);
      xrMode = true;
      player.setXRMode(true);
      document.body.classList.add("vr-mode");
      vrButton.textContent = "Exit VR";
      try {
        await office.renderer.xr.setSession(session);
        xrWorldPanel.visible = !session.domOverlayState;
        refreshXRWorldPanel();
      }
      catch (problem) { await session.end().catch(() => undefined); endXR(); throw problem; }
    }).catch((problem) => hud.toast(problem instanceof Error ? problem.message : "VR session could not start"));
  });

  let lastBroadcast = 0;
  let lastPropBroadcast = 0;
  let lastSceneRender = -Infinity;
  let lastSent = { x: player.x, y: player.worldY, z: player.z, yaw: player.facing, seated: player.seated };
  const clock = new THREE.Clock();
  let elapsed = 0;

  const frame = (_time: number, xrFrame?: XRFrame) => {
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;
    updateXRMovement(xrFrame);
    vehicles.update(dt, !phone.isOpen && !computer?.isOpen && !activeWorkerDesktop?.isOpen && !overlay.blocksOfficeInput && !board.isOpen && !stickyNoteEditor.isOpen && !(document.activeElement instanceof HTMLElement && document.activeElement.matches("input,textarea,[contenteditable=true]")));
    player.update(dt, elapsed);
    office.moveHeldObject(player.x, player.z, player.facing);
    audio.setWalking(player.moving && !player.seated);
    remotes.update(dt, elapsed);
    workers.update(dt);
    office.update(dt, player.x, player.z);
    const indoors = Math.abs(player.x) < office.options.width / 2 && Math.abs(player.z) < office.options.depth / 2;
    audio.setWeather(office.weather.current, office.weather.windStrength, office.weather.isNight, indoors);
    audio.updateWeather(dt);
    officeDog.update(dt);
    if (office.consumeDoorSound()) audio.playDoor();
    if (ridingElevator) player.setTransportHeight(office.elevator.carY);
    board.update();
    player.lookEnabled = !vehicles.driving.active && !board.isOpen && !stickyNoteEditor.isOpen && !office.wallArt.isDialogOpen && !phone?.isOpen;
    updateXRWorldPanel(xrFrame);
    updateVRTargets();
    if (office.wallArt.active) office.wallArt.update(wallAimRay());
    if (stickyNotePlacement >= 0) office.setStickyNotePreview(office.aimWall(wallAimRay()));
    office.setShadowMotion(player.moving || vehicles.driving.active || office.hasHeldObject || office.coffee.hasCup || office.coffee.state === "discarding" || office.elevator.moving || workers.all.some((worker) => worker.onBreak || worker.state === "working"));
    const sceneTime = performance.now(), backgroundScene = !xrMode && (phone.isOpen || computer?.isOpen || activeWorkerDesktop?.isOpen || overlay.blocksOfficeInput || board.isOpen || stickyNoteEditor.isOpen);
    if (!backgroundScene || sceneTime - lastSceneRender >= 1000 / 24) { youtube.update(); office.render(); lastSceneRender = sceneTime; }
    chat.update(office.camera, self.id, { x: player.x, y: player.seated ? player.worldY + 0.28 : player.worldY, z: player.z, seated: player.seated });

    const now = performance.now();
    if (now - lastPropBroadcast > 90) {
      const position = office.heldObjectPosition();
      if (position) {
        api.send("prop_move", { prop: position });
        lastPropBroadcast = now;
      }
    }
    if (now - lastBroadcast > 90 && (player.moving || Math.hypot(player.x - lastSent.x, player.worldY - lastSent.y, player.z - lastSent.z) > 0.01 || Math.abs(player.facing - lastSent.yaw) > 0.01 || player.seated !== lastSent.seated)) {
      api.send("presence_move", { x: player.x, y: player.worldY, z: player.z, yaw: player.facing, seated: player.seated });
      lastBroadcast = now;
      lastSent = { x: player.x, y: player.worldY, z: player.z, yaw: player.facing, seated: player.seated };
    }

    const target = focus();
    if (!xrMode && document.pointerLockElement === office.renderer.domElement) { const checkAt = performance.now(); if (checkAt - pointerAimUpdatedAt >= 80) { pointerAimUpdatedAt = checkAt; pointedTarget = findPointedTarget(); if (pointedTarget && !canPointInteract(pointedTarget)) pointedTarget = null; } } else { pointedTarget = null; pointerAimUpdatedAt = 0; }
    if (stickyNotePlacement >= 0) {
      hud.setContext("Place sticky note", [["E", "place on wall"], ["Esc", "cancel"]]);
    } else if (office.wallArt.active) {
      hud.setContext("Hang picture", [["E", "hang on wall"], ["Esc", "cancel"]]);
    } else if (xrMode) {
      const label = xrTarget?.kind === "worker-computer" ? "Agent computer" : xrTarget?.kind === "boss-computer" ? "Office computer" : xrTarget?.kind === "desk" ? "Desk" : xrTarget?.kind === "exit" ? "Exit door" : xrTarget?.kind === "elevator" ? "Elevator" : xrTarget?.kind === "dog" ? "Milo" : xrTarget?.kind === "light-row" ? "Office lights" : xrTarget?.kind === "blind-control" ? office.blindControls.find((control) => control.id === (xrTarget as Extract<XRTarget, { kind: "blind-control" }>).id)?.label ?? "Window shade" : xrTarget?.kind === "board" ? "Whiteboard" : xrTarget?.kind === "breakroom-switch" ? "Break room lights" : "The office";
      const trigger = xrTarget?.kind === "worker-computer" || xrTarget?.kind === "boss-computer" ? "open computer" : "interact";
      hud.setContext(label, [["Left stick", "walk"], ["Right stick", "snap turn"], ["Trigger", trigger]]);
    } else if (vehicles.driving.active) {
      hud.setContext(`${vehicles.driving.current?.name ?? "Vehicle"} · ${Math.round(Math.abs(vehicles.driving.pose?.speed ?? 0) * 2.23694)} mph`, [["WASD", "drive"], ["Space", "brake"], ["E", "exit car"], ["J", "horn"]]);
    } else if (!readOnly && office.coffee.hint(player.x, player.z, player.worldY)) {
      const coffee = office.coffee.hint(player.x, player.z, player.worldY)!; hud.setContext(coffee.label, [["E", coffee.action], ...(office.coffee.hasCup ? [["F", "put down cup"]] as [string, string][] : [])]);
    } else if (!readOnly && vehicles.driving.nearest(player.x, player.z, player.worldY)) {
      hud.setContext(vehicles.driving.nearest(player.x, player.z, player.worldY)!.name, [["E", "enter car"]]);
    } else if (atBossDesk()) {
      hud.setContext("Your desk", [["E", player.seated ? "computer" : "sit"], ["Q", "hire worker"]]);
    } else if (atElevator()) {
      const playerFloor = office.elevator.walkSurfaces.reduce((nearest, surface) => Math.abs(player.worldY - surface.height) < Math.abs(player.worldY - nearest) ? surface.height : nearest, office.elevator.walkSurfaces[0].height);
      const insideElevator = Math.abs(player.x - office.elevator.carPosition.x) < 0.9 && Math.abs(player.z - office.elevator.carPosition.z) < 1.1 && Math.abs(player.worldY - office.elevator.carY) < 0.45;
      hud.setContext(`Elevator · ${office.elevator.currentFloor === 0 ? "Office" : "Garage"}`, [["E", insideElevator ? "ride to the other floor" : office.elevator.currentFloor !== playerFloor ? "call elevator" : "walk inside to ride"]]);
    } else if (atExitDoor()) {
      hud.setContext("Exit door", [["E", "open or close"]]);
    } else if (atWatercooler()) {
      hud.setContext("Watercooler", [["E", "get water"]]);
    } else if (!readOnly && atBreakroomSwitch()) {
      hud.setContext("Break room lights", [["E", office.breakroomOn ? "turn off" : "turn on"]]);
    } else if (isXRTarget("dog") || !xrMode && officeDog.isNear(player.x, player.z, player.worldY)) {
      hud.setContext("Milo", [["E", "pet the dog"]]);
    } else if (office.roomSeatAt(player.x, player.z)) {
      hud.setContext(office.roomSeatAt(player.x, player.z)!.label, [["E", player.seated ? "stand" : "sit"]]);
    } else if (stickyNoteAt() >= 0) {
      const note = stickyNoteAt();
      hud.setContext(`Sticky note ${note + 1}`, [["E", readOnly ? "read note" : "edit note"]]);
    } else if (!readOnly && lightRowSwitchAt() >= 0) {
      const row = lightRowSwitchAt();
      hud.setContext(`Office light row ${row + 1}`, [["E", office.lightRows[row] ? "turn off" : "turn on"]]);
    } else if (!readOnly && blindControlAt()) {
      const id = blindControlAt(), control = office.blindControls.find((item) => item.id === id), stage = office.blindStages[id] ?? 0;
      hud.setContext(control?.label ?? "Window shade", [["E", stage === 0 ? "lower blind" : stage === 1 ? "close blind" : "raise blind"]]);
    } else if (atBoard()) {
      const hints: [string, string][] = [["E", "open editor"]];
      if (board.canDraw) hints.push(["Ctrl+drag", "draw on the wall"]);
      hud.setContext("Whiteboard", hints);
    } else if (target?.worker) {
      const hints: [string, string][] = [["T", "open terminal"]];
      if (user.role === "owner") hints.push(["C", "open computer"]);
      if (!readOnly) hints.push(["N", "nickname / computer icon"]);
      if (!readOnly) hints.push(["G", "send home"]);
      hud.setContext(`${target.worker.name} — ${target.worker.state}`, hints);
    } else if (target) {
      const hints: [string, string][] = readOnly ? [] : [["Q", "hire a worker"]];
      hints.push(["E", player.seated ? "stand" : "sit"]);
      hints.push(["WASD", "walk"]);
      if (user.role === "owner") hints.push(["Alt/Ctrl", "free mouse"]);
      hud.setContext(`Desk ${target.seat.id + 1} — empty`, hints);
    } else {
      const hints: [string, string][] = [];
      hints.push(["E", player.seated ? "stand" : "sit nearby"]);
      hints.push(["WASD", "walk"]);
      if (user.role === "owner") hints.push(["Alt/Ctrl", "free mouse"]);
      hud.setContext(readOnly ? "Guest mode" : "The office", hints);
    }
    if (!xrMode) {
      hud.addContextHint("B", "chat");
      if (pointedTarget) hud.addContextHint("Click", "interact");
      if (!vehicles.driving.active && !readOnly && stickyNotePlacement < 0 && !office.wallArt.active) { if (!target?.worker) hud.addContextHint("N", "place sticky note"); hud.addContextHint("H", "hang picture"); }
      if (!vehicles.driving.active && !office.coffee.hasCup && !readOnly && office.hasHeldObject) hud.addContextHint("F", "drop object");
      else if (!vehicles.driving.active && !office.coffee.hasCup && !readOnly && office.hasMovableNear(player.x, player.z)) hud.addContextHint("F", "pick up object");
      if (dictation) { hud.addContextHint("V", "hold to dictate"); hud.addContextHint("Shift+V", "toggle mic"); }
      if (officeDog.isNear(player.x, player.z, player.worldY)) hud.addContextHint("R", "tell Milo to rest / wake");
      if (phone) hud.addContextHint("↑", phone.isOpen ? "close phone" : "open phone");
    }
  };
  office.renderer.setAnimationLoop(frame);
}

function buildFireConfirmation(confirm: (worker: Worker) => void): { readonly isOpen: boolean; open: (worker: Worker) => void; close: () => void } {
  const root = document.createElement("dialog");
  root.className = "worker-edit-dialog fire-worker-dialog";
  root.innerHTML = `<form><header><strong>Fire worker?</strong><button type="button" data-close aria-label="Close">×</button></header><div data-message></div><footer><button type="button" data-cancel>Keep worker</button><button type="button" class="danger" data-fire>Fire worker</button></footer></form>`;
  document.body.appendChild(root);
  const message = root.querySelector<HTMLElement>("[data-message]")!;
  message.style.cssText = "color:#394653;font:14px/1.45 system-ui,sans-serif";
  const fire = root.querySelector<HTMLButtonElement>("[data-fire]")!;
  fire.style.cssText = "border-color:#a72822;background:#b63832;color:white";
  const keep = root.querySelector<HTMLButtonElement>("[data-cancel]")!;
  let selected: Worker | null = null;
  const close = () => { selected = null; if (root.open) root.close(); };
  root.querySelector("[data-close]")!.addEventListener("click", close);
  keep.addEventListener("click", close);
  root.addEventListener("cancel", () => { selected = null; });
  fire.addEventListener("click", () => { const worker = selected; if (!worker) return; selected = null; root.close(); confirm(worker); });
  return {
    get isOpen() { return root.open; },
    open(worker) { selected = worker; message.textContent = `This stops ${worker.name}'s session and removes their laptop from the office.`; fire.textContent = `Fire ${worker.name}`; if (!root.open) root.showModal(); keep.focus(); },
    close
  };
}

function buildWorkerEditor(save: (id: string, title: string, icon: string) => Promise<void>): {
  readonly isOpen: boolean;
  open: (worker: Pick<Worker, "terminalId" | "name" | "icon">) => void;
  close: () => void;
} {
  const root = document.createElement("dialog");
  root.className = "worker-edit-dialog";
  root.innerHTML = `<form><header><strong>Edit worker computer</strong><button type="button" data-cancel aria-label="Close">×</button></header><label>Nickname<input data-name maxlength="48" autocomplete="off"></label><label>Built-in icon<select data-icon></select></label><label>Custom icon<input data-icon-file type="file" accept="image/png,image/jpeg,image/webp"></label><img data-icon-preview alt="Laptop icon preview" hidden><p data-error role="status"></p><footer><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Save</button></footer></form>`;
  document.body.appendChild(root);
  const form = root.querySelector("form")!;
  const name = root.querySelector<HTMLInputElement>("[data-name]")!;
  const icon = root.querySelector<HTMLSelectElement>("[data-icon]")!;
  const iconFile = root.querySelector<HTMLInputElement>("[data-icon-file]")!;
  const iconPreview = root.querySelector<HTMLImageElement>("[data-icon-preview]")!;
  iconPreview.style.cssText = "width:48px;height:48px;object-fit:contain;justify-self:start";
  const error = root.querySelector<HTMLElement>("[data-error]")!;
  const saveButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let workerId = "";
  let customIcon = "";
  for (const optionData of modelIconOptions) { const option = document.createElement("option"); option.value = optionData.id; option.textContent = optionData.label; icon.appendChild(option); }
  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "Custom image";
  icon.appendChild(customOption);
  const selectedIcon = () => icon.value === "custom" ? customIcon : modelIconPath(icon.value);
  const showPreview = () => { const path = selectedIcon(); if (path) { iconPreview.src = path; iconPreview.hidden = false; } else { iconPreview.removeAttribute("src"); iconPreview.hidden = true; } };
  icon.addEventListener("change", () => { if (icon.value !== "custom") { customIcon = ""; iconFile.value = ""; } showPreview(); });
  iconFile.addEventListener("change", () => {
    const file = iconFile.files?.[0];
    if (!file) return;
    void readCustomLaptopIcon(file).then((value) => { customIcon = value; icon.value = "custom"; error.textContent = "Custom image ready."; showPreview(); }).catch((problem) => { error.textContent = problem instanceof Error ? problem.message : String(problem); });
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-cancel]")) button.addEventListener("click", () => root.close());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = name.value.trim();
    if (!title) { error.textContent = "Enter a nickname"; return; }
    const selected = selectedIcon();
    if (icon.value === "custom" && !selected) { error.textContent = "Choose a custom image first."; return; }
    saveButton.disabled = true;
    error.textContent = "";
    void save(workerId, title, icon.value === "custom" ? customIcon : icon.value).then(() => root.close()).catch((problem) => { error.textContent = problem instanceof Error ? problem.message : "Could not save worker details"; }).finally(() => { saveButton.disabled = false; });
  });
  return {
    get isOpen() { return root.open; },
    open(worker) { workerId = worker.terminalId; name.value = worker.name; customIcon = isCustomLaptopIcon(worker.icon) ? worker.icon : ""; icon.value = customIcon ? "custom" : worker.icon || modelIconOptions[0]?.id || ""; iconFile.value = ""; error.textContent = ""; showPreview(); if (!root.open) root.showModal(); name.focus(); name.select(); },
    close() { if (root.open) root.close(); }
  };
}

function buildHireMenu(office: Office, hire: (profile: AgentProfile, seat: Seat, cwd: string, icon: string) => Promise<void>): {
  open: (seat?: Seat, container?: HTMLElement) => Promise<void>;
  close: () => void;
} {
  const root = document.createElement("section");
  root.className = "panel";
  root.id = "hire";
  root.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:430px;padding:16px 18px;z-index:50;display:none";
  document.body.appendChild(root);
  return {
    async open(seat?: Seat, container?: HTMLElement) {
      const [profiles, options] = await Promise.all([
        api.request<AgentProfile[]>("detect_agent_profiles"),
        api.request<{ default: string; recent: string[] }>("workspace_options").catch(() => ({ default: "", recent: [] }))
      ]);
      if (container) {
        container.replaceChildren();
        container.appendChild(root);
        root.style.cssText = "position:relative;left:auto;top:auto;transform:none;width:100%;max-height:none;overflow:auto;padding:4px;border:0;border-radius:0;box-shadow:none;display:block";
      } else {
        document.body.appendChild(root);
        root.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:430px;padding:16px 18px;z-index:50;display:block";
      }
      root.innerHTML = `<h2>${seat ? "Hire for this desk" : "Hire a worker"}</h2>
        <label class="field">Working folder<input type="text" data-cwd /></label>
        <datalist data-recent></datalist><div class="rows"></div>`;
      const input = root.querySelector<HTMLInputElement>("[data-cwd]")!;
      input.value = options.default;
      const recent = root.querySelector<HTMLDataListElement>("[data-recent]")!;
      for (const path of options.recent) {
        const option = document.createElement("option");
        option.value = path;
        recent.appendChild(option);
      }
      const rows = root.querySelector(".rows")!;
      if (!profiles.length) rows.innerHTML = `<div class="row"><span class="meta">no agent CLIs found on PATH</span></div>`;
      for (const profile of profiles) {
        const row = document.createElement("div");
        row.className = "row";
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = profile.accent;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = profile.name;
        const role = document.createElement("span");
        role.className = "meta";
        role.textContent = profile.role;
        row.append(swatch, name, role);
        const icon = document.createElement("select");
        icon.title = `${profile.name} laptop logo`;
        icon.style.maxWidth = "100px";
        for (const optionData of modelIconOptions) {
          const option = document.createElement("option");
          option.value = optionData.id;
          option.textContent = optionData.label;
          icon.appendChild(option);
        }
        icon.value = defaultModelIcon(profile.id);
        row.appendChild(icon);
        const button = document.createElement("button");
        button.className = "primary";
        button.textContent = "Hire";
        button.style.marginLeft = "auto";
        button.addEventListener("click", async () => {
          const target = seat ?? office.freeSeat();
          if (!target) return;
          root.style.display = "none";
          await hire(profile, target, input.value.trim(), icon.value);
        });
        row.appendChild(button);
        rows.appendChild(row);
      }
      const close = document.createElement("button");
      close.textContent = "Close";
      close.style.marginTop = "8px";
      close.addEventListener("click", () => (root.style.display = "none"));
      root.appendChild(close);
      input.focus();
    },
    close() {
      root.style.display = "none";
    }
  };
}
