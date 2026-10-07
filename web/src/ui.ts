import type { Avatar, User } from "./api";
import type { Worker } from "./worker";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.textContent = html;
  return node;
}

export class Hud {
  readonly layer = el("div", "hud");
  readonly chatInput: HTMLInputElement;
  private readonly roster: HTMLElement;
  private readonly banned: HTMLElement;
  private readonly guests: HTMLElement;
  private readonly context: HTMLElement;
  private contextKey = "";
  private onKick?: (name: string) => void;
  private onBan?: (name: string) => void;
  private onUnban?: (name: string) => void;
  private onNickname?: (name: string, nickname: string) => void;

  constructor(user: User) {
    const toolbar = el("div");
    toolbar.id = "toolbar";

    this.roster = el("aside", "panel");
    this.roster.id = "roster";
    this.banned = el("div");

    this.guests = el("aside", "panel");
    this.guests.id = "guests";
    this.guests.innerHTML = `<h2>Waiting at the door</h2><div class="list"></div>`;

    this.context = el("div", "panel");
    this.context.id = "context";

    const chat = el("div");
    chat.id = "chat";
    this.chatInput = el("input") as HTMLInputElement;
    this.chatInput.type = "text";
    this.chatInput.maxLength = 280;
    this.chatInput.placeholder = "Press B to talk to the office";
    chat.appendChild(this.chatInput);

    for (const node of [toolbar, this.roster, this.guests, this.context, chat]) this.layer.appendChild(node);
    document.body.appendChild(this.layer);
    this.guests.style.display = "none";
    if (user.role === "guest") this.guests.remove();
  }

  addToolbarButton(label: string, action: () => void): void {
    const button = el("button", "primary", label);
    button.addEventListener("click", action);
    document.getElementById("toolbar")!.prepend(button);
  }

  onChat(send: (text: string) => boolean): void {
    this.chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return this.chatInput.blur();
      if (event.key !== "Enter") return;
      const text = this.chatInput.value.trim();
      if (!send(text)) return;
      this.chatInput.value = "";
      this.chatInput.blur();
    });
  }

  toast(text: string): void {
    const bubble = el("div", "toast", text);
    document.body.appendChild(bubble);
    setTimeout(() => bubble.classList.add("show"), 20);
    setTimeout(() => {
      bubble.classList.remove("show");
      setTimeout(() => bubble.remove(), 400);
    }, 2600);
  }

  setContext(label: string, hints: [string, string][]): void {
    const distinctHints = hints.filter((hint, index) => hints.findIndex(([key, text]) => key === hint[0] && text === hint[1]) === index);
    const key = JSON.stringify([label, distinctHints]);
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.context.replaceChildren();
    this.context.appendChild(el("strong", undefined, label));
    for (const [key, text] of distinctHints) {
      const hint = el("span", "keys");
      hint.append(el("kbd", undefined, key), document.createTextNode(text));
      this.context.appendChild(hint);
    }
  }

  addContextHint(key: string, text: string): void {
    if ([...this.context.querySelectorAll("kbd")].some((entry) => entry.textContent === key)) return;
    const hint = el("span", "keys");
    hint.append(el("kbd", undefined, key), document.createTextNode(text));
    this.context.appendChild(hint);
  }

  setRoster(people: Avatar[], workers: Worker[], selfId: string): void {
    this.roster.innerHTML = "<h2>In the office</h2>";
    for (const person of people) {
      const row = el("div", "row");
      const swatch = el("span", "swatch");
      swatch.style.background = person.color;
      const name = el("span", "name");
      name.textContent = person.displayName + (person.connectionId === selfId ? " (you)" : "");
      const role = el("span", `pill ${person.role}`, person.role === "owner" ? "admin" : person.role);
      row.append(swatch, name, role);
      if (person.connectionId !== selfId && this.onNickname) {
        const nickname = el("button", undefined, "Nick");
        nickname.title = `Set nickname for ${person.displayName}`;
        nickname.addEventListener("click", () => {
          const value = prompt("Nickname", person.displayName);
          if (value !== null) this.onNickname!(person.username, value);
        });
        row.appendChild(nickname);
      }
      if (person.connectionId !== selfId && person.role !== "owner" && this.onKick && this.onBan) {
        const kick = el("button", undefined, "Kick");
        const ban = el("button", "danger", "Ban");
        kick.title = `Kick ${person.displayName}`;
        ban.title = `Ban ${person.displayName}`;
        kick.addEventListener("click", () => this.onKick!(person.username));
        ban.addEventListener("click", () => this.onBan!(person.username));
        row.append(kick, ban);
      }
      this.roster.appendChild(row);
    }
    this.roster.appendChild(el("h2", undefined, "Workers"));
    if (!workers.length) this.roster.appendChild(el("div", "row", "no workers yet"));
    for (const worker of workers) {
      const row = el("div", "row");
      const swatch = el("span", "swatch");
      swatch.style.background = worker.accent;
      const name = el("span", "name");
      name.textContent = worker.name;
      const meta = el("span", "meta");
      const state = el("span", `pill ${worker.state}`);
      state.textContent = worker.state;
      meta.appendChild(state);
      row.append(swatch, name, meta);
      this.roster.appendChild(row);
    }
    this.roster.appendChild(this.banned);
  }

  setModeration(onKick: (name: string) => void, onBan: (name: string) => void, onUnban: (name: string) => void, onNickname: (name: string, nickname: string) => void): void {
    this.onKick = onKick;
    this.onBan = onBan;
    this.onUnban = onUnban;
    this.onNickname = onNickname;
  }

  setBannedUsers(users: User[]): void {
    this.banned.replaceChildren();
    if (!users.length) return;
    this.banned.appendChild(el("h2", undefined, "Banned"));
    for (const user of users) {
      const row = el("div", "row");
      const name = el("span", "name");
      name.textContent = user.displayName;
      const unban = el("button", undefined, "Unban");
      unban.addEventListener("click", () => this.onUnban?.(user.username));
      row.append(name, unban);
      this.banned.appendChild(row);
    }
  }

  setPendingGuests(guests: { displayName: string; color: string }[], onApprove: (name: string) => void, onDeny: (name: string) => void): void {
    this.guests.style.display = guests.length ? "block" : "none";
    if (!guests.length) return;
    const list = this.guests.querySelector(".list")!;
    list.innerHTML = "";
    for (const guest of guests) {
      const row = el("div");
      const identity = el("div", "row");
      const swatch = el("span", "swatch");
      swatch.style.background = guest.color;
      const name = el("span", "name");
      name.textContent = guest.displayName;
      identity.append(swatch, name, el("span", "meta", "wants in"));
      const actions = el("div", "actions");
      const approve = el("button", "primary", "Let in");
      approve.addEventListener("click", () => onApprove(guest.displayName));
      const deny = el("button", "danger", "Decline");
      deny.addEventListener("click", () => onDeny(guest.displayName));
      actions.append(approve, deny);
      row.append(identity, actions);
      list.appendChild(row);
    }
  }
}

export function buildGate(onAuthenticated: (user: User) => void): GateElement {
  const gate = el("div");
  gate.id = "gate";
  gate.innerHTML = `
    <div class="card panel">
      <p class="sub">Sign in, or knock and wait for someone to let you in.</p>
      <div class="tabs">
        <button data-tab="signin" aria-selected="true">Sign in</button>
        <button data-tab="register">Create account</button>
        <button data-tab="guest">Guest</button>
      </div>
      <div data-pane="signin">
        <label>Username</label><input type="text" data-f="username" autocomplete="username" />
        <label>Password</label><input type="password" data-f="password" autocomplete="current-password" />
        <label class="remember"><input type="checkbox" data-remember> Remember me on this device</label>
        <div class="row-btns"><button class="primary" data-go="auth_login">Sign in</button></div>
      </div>
      <div data-pane="register" hidden>
        <label>Username</label><input type="text" data-f="username" autocomplete="username" />
        <label>Password</label><input type="password" data-f="password" autocomplete="new-password" />
        <div class="row-btns"><button class="primary" data-go="auth_register">Create account</button></div>
      </div>
      <div data-pane="guest" hidden>
        <label>Name to appear as</label><input type="text" data-f="username" />
        <div class="row-btns"><button class="primary" data-go="auth_guest_request">Knock</button></div>
        <div class="pending" data-wait hidden>Waiting for someone to let you in…</div>
      </div>
      <p class="error"></p>
    </div>`;

  const error = gate.querySelector<HTMLElement>(".error")!;
  const wait = gate.querySelector<HTMLElement>("[data-wait]")!;
  const remember = gate.querySelector<HTMLInputElement>("[data-remember]")!;
  const rememberedLoginKey = "agent-office-remembered-login";
  try {
    const saved = JSON.parse(localStorage.getItem(rememberedLoginKey) ?? "null");
    if (typeof saved?.username === "string" && typeof saved?.password === "string") {
      gate.querySelector<HTMLInputElement>('[data-pane="signin"] [data-f="username"]')!.value = saved.username;
      gate.querySelector<HTMLInputElement>('[data-pane="signin"] [data-f="password"]')!.value = saved.password;
      remember.checked = true;
    }
  } catch {}
  remember.addEventListener("change", () => { if (!remember.checked) try { localStorage.removeItem(rememberedLoginKey); } catch {} });
  let tab = "signin";
  let poller = 0;

  const show = (next: string) => {
    tab = next;
    for (const button of gate.querySelectorAll<HTMLElement>("[data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === next));
    }
    for (const pane of gate.querySelectorAll<HTMLElement>("[data-pane]")) {
      pane.hidden = pane.dataset.pane !== next;
    }
    error.textContent = "";
  };
  for (const button of gate.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => show(button.dataset.tab!));
  }

  const field = (name: string) => gate.querySelector<HTMLInputElement>(`[data-pane="${tab}"] [data-f="${name}"]`)!;

  const post = async (command: string, args: Record<string, any>) => {
    const response = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, args })
    });
    const payload = await response.json().catch(() => ({ ok: false, error: "server unreachable" }));
    if (!payload.ok) throw new Error(payload.error);
    return payload.data;
  };

  for (const button of gate.querySelectorAll<HTMLButtonElement>("[data-go]")) {
    button.addEventListener("click", async () => {
      error.textContent = "";
      const command = button.dataset.go!;
      const username = field("username").value.trim();
      if (!username) return (error.textContent = "enter a username");
      button.disabled = true;
      try {
        if (command === "auth_guest_request") {
          const request = await post(command, { username });
          const requestToken = request.requestToken as string;
          wait.hidden = false;
          button.textContent = "Knocking…";
          clearInterval(poller);
          poller = window.setInterval(async () => {
            try {
              const result = await post("auth_guest_poll", { username, requestToken });
              if (result.approved) {
                clearInterval(poller);
                onAuthenticated(result.user);
              }
            } catch (problem: any) {
              if (problem.message !== "no such guest request") return;
              clearInterval(poller);
              wait.hidden = true;
              button.disabled = false;
              button.textContent = "Knock";
              error.textContent = "request expired or declined";
            }
          }, 1500);
        } else {
          const password = field("password").value;
          const result = await post(command, { username, password });
          if (command === "auth_login") try { if (remember.checked) localStorage.setItem(rememberedLoginKey, JSON.stringify({ username, password })); else localStorage.removeItem(rememberedLoginKey); } catch {}
          onAuthenticated(result.user);
        }
      } catch (problem: any) {
        error.textContent = problem.message;
        button.disabled = false;
        if (command === "auth_guest_request") {
          clearInterval(poller);
          wait.hidden = true;
          button.textContent = "Knock";
        }
      }
    });
  }
  for (const input of gate.querySelectorAll<HTMLInputElement>("[data-f]")) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") gate.querySelector<HTMLButtonElement>(`[data-go="${tab === "guest" ? "auth_guest_request" : tab === "register" ? "auth_register" : "auth_login"}"]`)!.click();
    });
  }
  const gateWithApi = gate as unknown as GateElement;
  gateWithApi.setAllowCreate = (allowed: boolean) => {
    if (allowed) return;
    gate.querySelector<HTMLElement>('[data-tab="register"]')!.style.display = "none";
    if (tab === "register") show("signin");
  };
  return gateWithApi;
}

export interface GateElement extends HTMLElement {
  setAllowCreate: (allowed: boolean) => void;
}
