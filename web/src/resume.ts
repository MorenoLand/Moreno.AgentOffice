import type { Api, Terminal } from "./api";
import type { Office, Seat } from "./office";
import type { Workers } from "./worker";

export class ResumeWorkers {
  private button = document.createElement("button");
  private panel = document.createElement("section");
  private saved: Terminal[] = [];

  constructor(private api: Api, private office: Office, private workers: Workers, private onResumed: (terminal: Terminal) => void, private onError: (message: string) => void) {
    this.button.textContent = "Resume workers";
    this.button.style.display = "none";
    this.button.addEventListener("click", () => void this.open());
    document.getElementById("toolbar")!.prepend(this.button);
    this.panel.className = "panel";
    this.panel.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 28px));max-height:75vh;overflow:auto;padding:16px 18px;z-index:50;display:none";
    document.body.appendChild(this.panel);
  }

  private seatFor(terminal: Terminal): Seat | undefined {
    return this.office.seats.find((seat) => Math.hypot(seat.x - Number(terminal.swarmX), seat.z - Number(terminal.swarmY)) < 0.05) ?? this.office.freeSeat();
  }

  async refresh(): Promise<void> {
    const [saved, running] = await Promise.all([
      this.api.request<Terminal[]>("list_saved_terminal_deck"),
      this.api.request<Terminal[]>("list_terminals")
    ]);
    const active = new Set(running.filter((terminal) => terminal.state === "running" || terminal.state === "launching").map((terminal) => terminal.id));
    this.saved = saved.filter((terminal) => !active.has(terminal.id) && terminal.command && terminal.profileId !== "boss-shell");
    this.button.style.display = this.saved.length ? "" : "none";
    if (!this.saved.length) this.close();
  }

  async restoreAll(): Promise<void> {
    const [saved, running] = await Promise.all([
      this.api.request<Terminal[]>("list_saved_terminal_deck"),
      this.api.request<Terminal[]>("list_terminals")
    ]);
    const active = new Set(running.filter((terminal) => terminal.state === "running" || terminal.state === "launching").map((terminal) => terminal.id));
    for (const terminal of running) {
      if (terminal.profileId === "boss-shell") continue;
      const worker = this.workers.adopt(terminal);
      if (worker) this.workers.setState(terminal.id, terminal.activityState === "working" ? "working" : terminal.activityState === "done" ? "done" : terminal.activityState === "failed" ? "failed" : "idle");
    }
    for (const terminal of saved.filter((item) => !active.has(item.id) && item.command && item.profileId !== "boss-shell")) {
      const seat = this.seatFor(terminal);
      if (!seat || seat.occupant !== null) continue;
      try {
        const resumed = await this.api.request<Terminal>("resume_terminal", { id: terminal.id });
        if (this.workers.adopt(resumed, seat)) this.onResumed(resumed);
      } catch (problem) { this.onError(problem instanceof Error ? problem.message : String(problem)); }
    }
    await this.refresh();
  }

  async open(): Promise<void> {
    try {
      await this.refresh();
    } catch (problem) {
      this.onError(problem instanceof Error ? problem.message : String(problem));
      return;
    }
    if (!this.saved.length) return;
    this.panel.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Resume workers";
    this.panel.appendChild(heading);
    for (const saved of this.saved) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.className = "name";
      label.textContent = saved.title;
      const seat = this.seatFor(saved);
      const location = document.createElement("span");
      location.className = "meta";
      location.textContent = seat ? `Desk ${seat.id + 1}` : "No free desk";
      const button = document.createElement("button");
      button.className = "primary";
      button.textContent = seat?.occupant ? "Desk occupied" : "Resume";
      button.disabled = !seat || seat.occupant !== null;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const terminal = await this.api.request<Terminal>("resume_terminal", { id: saved.id });
          this.workers.adopt(terminal);
          this.onResumed(terminal);
          await this.refresh();
          if (this.saved.length) await this.open();
        } catch (problem) {
          button.disabled = false;
          this.onError(problem instanceof Error ? problem.message : String(problem));
        }
      });
      row.append(label, location, button);
      this.panel.appendChild(row);
    }
    const close = document.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    this.panel.appendChild(close);
    this.panel.style.display = "block";
  }

  close(): void {
    this.panel.style.display = "none";
  }
}
