import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Api, Terminal } from "./api";

export class TerminalOverlay {
  private term = new XTerm({
    fontFamily: "ui-monospace, Cascadia Mono, Consolas, monospace",
    fontSize: 13,
    convertEol: false,
    scrollback: 6000,
    theme: { background: "#12100e", foreground: "#e8e2d6", cursor: "#3ddc84" }
  });
  private fit = new FitAddon();
  private current: Terminal | null = null;
  private history = new Map<string, string[]>();
  private readonly root: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly title: HTMLElement;
  private readonly field: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private desktopTaskbar?: HTMLButtonElement;
  private desktopMaximized = false;
  private dragOffset: { x: number; y: number } | null = null;

  constructor(private api: Api, private readOnly: boolean, private onResize?: (id: string, cols: number, rows: number) => void, rootId = "terminal") {
    this.root = document.createElement("section");
    this.root.id = rootId;
    this.root.className = "panel terminal-window";
    this.root.innerHTML = `
      <header>
        <span class="terminal-app-icon">›_</span>
        <span class="title"></span>
        <span class="spacer"></span>
        <button data-act="minimize" aria-label="Minimize terminal" title="Minimize">−</button>
        <button data-act="maximize" aria-label="Maximize terminal" title="Maximize">□</button>
        <button data-act="close" aria-label="Close terminal" title="Close">×</button>
      </header>
      <div class="screen"></div>
      <footer>
        <span class="share"></span>
        <input type="text" placeholder="Type a message and press Enter" />
        <button class="primary" data-act="send">Prompt</button>
        <button data-act="stop">Stop</button>
      </footer>`;
    document.body.appendChild(this.root);
    this.root.querySelector<HTMLElement>(".share")!.textContent = readOnly
      ? "You are watching this terminal · read-only"
      : "Everyone in the office shares this terminal";
    this.screen = this.root.querySelector(".screen")!;
    this.title = this.root.querySelector(".title")!;
    this.field = this.root.querySelector("input")!;
    this.note = this.root.querySelector(".readonly") ?? document.createElement("span");

    this.term.loadAddon(this.fit);
    this.term.open(this.screen);
    this.term.onResize(({ cols, rows }) => {
      if (this.current && !this.readOnly) {
        this.api.send("resize_terminal", { id: this.current.id, cols, rows });
        this.onResize?.(this.current.id, cols, rows);
      }
    });
    this.term.onData((data) => {
      if (this.current && !this.readOnly) this.api.send("write_terminal", { id: this.current.id, data });
    });
    this.screen.addEventListener("pointerdown", () => this.term.focus());

    this.root.querySelector('[data-act="minimize"]')!.addEventListener("click", () => this.minimize());
    this.root.querySelector('[data-act="maximize"]')!.addEventListener("click", () => this.toggleMaximize());
    this.root.querySelector('[data-act="close"]')!.addEventListener("click", () => this.close());
    this.root.querySelector('[data-act="send"]')!.addEventListener("click", () => this.prompt());
    this.root.querySelector('[data-act="stop"]')!.addEventListener("click", () => {
      if (this.current) this.api.send("kill_terminal", { id: this.current.id });
    });
    this.field.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.prompt();
    });
    this.resizeObserver = new ResizeObserver(() => { if (this.isOpen) this.fit.fit(); });
    this.resizeObserver.observe(this.root);
    addEventListener("resize", () => { if (this.isOpen) this.fit.fit(); });
    const header = this.root.querySelector("header")!;
    header.addEventListener("pointerdown", (event) => {
      if (!this.root.classList.contains("desktop-window") || this.desktopMaximized || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      const bounds = this.root.getBoundingClientRect();
      this.dragOffset = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", (event) => {
      if (!this.dragOffset) return;
      if (this.root.classList.contains("desktop-window")) {
        const bounds = this.root.parentElement!.getBoundingClientRect();
        this.root.style.left = `${Math.max(0, Math.min(bounds.width - this.root.offsetWidth, event.clientX - bounds.left - this.dragOffset.x))}px`;
        this.root.style.top = `${Math.max(0, Math.min(bounds.height - this.root.offsetHeight, event.clientY - bounds.top - this.dragOffset.y))}px`;
        return;
      }
      this.root.style.left = `${Math.max(0, Math.min(innerWidth - 160, event.clientX - this.dragOffset.x))}px`;
      this.root.style.top = `${Math.max(0, Math.min(innerHeight - 80, event.clientY - this.dragOffset.y))}px`;
      this.root.style.transform = "none";
    });
    const stopDrag = () => { this.dragOffset = null; };
    header.addEventListener("pointerup", stopDrag);
    header.addEventListener("pointercancel", stopDrag);
    header.addEventListener("dblclick", (event) => { if (!(event.target as HTMLElement).closest("button")) this.toggleMaximize(); });
    this.applyRole();
  }

  private applyRole(): void {
    this.field.disabled = this.readOnly;
    this.field.placeholder = this.readOnly ? "read-only" : "Type a message and press Enter";
    for (const name of ["send", "stop"]) {
      const button = this.root.querySelector<HTMLButtonElement>(`[data-act="${name}"]`)!;
      button.style.display = this.readOnly ? "none" : "";
    }
    if (this.readOnly && !this.note.isConnected) {
      this.note.className = "readonly";
      this.note.textContent = "read-only";
      this.root.querySelector("footer")!.prepend(this.note);
    }
  }

  private prompt(): void {
    const text = this.field.value.trim();
    if (!text || !this.current) return;
    this.field.value = "";
    this.api.send("write_terminal", { id: this.current.id, data: `${text}\n` });
  }

  private ensureTaskbarButton(desktopLayer: HTMLElement, terminal: Terminal): void {
    const pinned = desktopLayer.closest(".office-desktop")?.querySelector<HTMLElement>(".desktop-pinned");
    if (!pinned) return;
    if (!this.desktopTaskbar) {
      this.desktopTaskbar = document.createElement("button");
      this.desktopTaskbar.className = "desktop-window-task desktop-terminal-task";
      this.desktopTaskbar.addEventListener("click", () => {
        if (this.isOpen) this.minimize();
        else { this.root.classList.remove("minimized"); this.root.classList.add("open"); this.desktopTaskbar?.classList.add("active"); document.body.classList.toggle("terminal-open", !!this.root.closest(".office-desktop")?.classList.contains("open")); requestAnimationFrame(() => this.fit.fit()); }
      });
    }
    this.desktopTaskbar.textContent = `›_ ${terminal.title}`;
    this.desktopTaskbar.title = terminal.title;
    this.desktopTaskbar.hidden = false;
    this.desktopTaskbar.classList.add("active");
    if (this.desktopTaskbar.parentElement !== pinned) pinned.appendChild(this.desktopTaskbar);
  }

  private minimize(): void {
    if (!this.root.classList.contains("desktop-window")) { this.close(); return; }
    this.root.classList.remove("open");
    this.root.classList.add("minimized");
    this.desktopTaskbar?.classList.remove("active");
    document.body.classList.remove("terminal-open");
  }

  private toggleMaximize(): void {
    this.desktopMaximized = !this.desktopMaximized;
    this.root.classList.toggle("maximized", this.desktopMaximized);
    const button = this.root.querySelector<HTMLButtonElement>('[data-act="maximize"]');
    if (button) { button.textContent = this.desktopMaximized ? "❐" : "□"; button.setAttribute("aria-label", `${this.desktopMaximized ? "Restore" : "Maximize"} terminal`); button.title = this.desktopMaximized ? "Restore" : "Maximize"; }
    requestAnimationFrame(() => this.fit.fit());
  }

  open(terminal: Terminal, desktopLayer?: HTMLElement): void {
    this.current = terminal;
    const desktopWindow = desktopLayer !== undefined;
    if (desktopWindow) desktopLayer.appendChild(this.root);
    else document.body.appendChild(this.root);
    if (desktopWindow) this.ensureTaskbarButton(desktopLayer, terminal);
    else { this.desktopTaskbar?.remove(); this.desktopTaskbar = undefined; }
    this.root.querySelector<HTMLButtonElement>('[data-act="minimize"]')!.hidden = !desktopWindow;
    this.root.querySelector<HTMLButtonElement>('[data-act="maximize"]')!.hidden = !desktopWindow;
    this.title.textContent = `${terminal.title} — ${terminal.cwd || terminal.command}`;
    this.root.classList.toggle("desktop-window", desktopWindow);
    this.root.classList.remove("maximized", "minimized");
    this.desktopMaximized = false;
    const maximizeButton = this.root.querySelector<HTMLButtonElement>('[data-act="maximize"]')!;
    maximizeButton.textContent = "□";
    maximizeButton.setAttribute("aria-label", "Maximize terminal");
    maximizeButton.title = "Maximize";
    this.root.style.left = "";
    this.root.style.top = "";
    this.root.style.transform = "";
    this.root.classList.add("open");
    document.body.classList.toggle("terminal-open", !desktopWindow || !!desktopLayer?.closest(".office-desktop")?.classList.contains("open"));
    this.term.reset();
    for (const line of this.history.get(terminal.id) ?? []) this.term.write(line);
    if (terminal.backlog) this.term.write(terminal.backlog);
    requestAnimationFrame(() => {
      this.fit.fit();
      if (!this.readOnly) this.term.focus();
    });
  }

  close(): void {
    this.root.classList.remove("open", "desktop-window", "maximized", "minimized");
    document.body.classList.remove("terminal-open");
    this.desktopTaskbar?.remove();
    this.desktopTaskbar = undefined;
    this.desktopMaximized = false;
    this.current = null;
  }

  get blocksOfficeInput(): boolean {
    return this.isOpen && (!this.root.classList.contains("desktop-window") || !!this.root.closest(".office-desktop")?.classList.contains("open"));
  }

  get isOpen(): boolean {
    return this.root.classList.contains("open");
  }

  get openId(): string | undefined {
    return this.current?.id;
  }

  ingest(terminalId: string, data: string): void {
    const lines = this.history.get(terminalId) ?? [];
    lines.push(data);
    this.history.set(terminalId, lines);
    if (this.current?.id === terminalId) this.term.write(data);
  }

  updateMetadata(terminal: Terminal): void {
    if (this.current?.id === terminal.id) this.title.textContent = `${terminal.title} — ${terminal.cwd || terminal.command}`;
  }

  setDesktopIdentity(id: string, title: string): void { this.root.dataset.terminalId = id; this.root.dataset.terminalTitle = title; }

  forget(terminalId: string): void {
    this.history.delete(terminalId);
    if (this.current?.id === terminalId) this.close();
  }
}
