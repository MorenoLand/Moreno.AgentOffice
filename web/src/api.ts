export type Role = "owner" | "member" | "guest";

export interface User {
  username: string;
  displayName: string;
  color: string;
  role: Role;
  approved: boolean;
}

export interface Avatar {
  connectionId: string;
  username: string;
  displayName: string;
  color: string;
  role: Role;
  x: number;
  y: number;
  z: number;
  yaw: number;
  seated: boolean;
}

export interface Terminal {
  id: string;
  profileId: string;
  title: string;
  role: string;
  accent: string;
  icon?: string;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  swarmX?: number;
  swarmY?: number;
  state: string;
  activityState?: string;
  backlog: string;
  mode: string;
  cols: number;
  rows: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  command: string;
  args: string[];
  accent: string;
  description: string;
}

type Handler = (data: any) => void;

export class Api {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<Handler>>();
  private queue: string[] = [];
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500;
  private hasWelcomed = false;
  private reconnectHooksInstalled = false;

  async rpc<T = any>(command: string, args: Record<string, any> = {}): Promise<T> {
    const response = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, args })
    });
    const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload.data as T;
  }

  send(command: string, args: Record<string, any> = {}): void {
    const frame = JSON.stringify({ id: this.nextId++, command, args });
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(frame);
    else this.enqueue(frame, command, args);
  }

  private enqueue(frame: string, command: string, args: Record<string, any>): void {
    if (command === "presence_move") this.queue = this.queue.filter((queued) => JSON.parse(queued).command !== command);
    else if (command === "prop_move") this.queue = this.queue.filter((queued) => {
      const pending = JSON.parse(queued);
      return pending.command !== command || pending.args?.prop?.id !== args.prop?.id;
    });
    this.queue.push(frame);
  }

  on(name: string, handler: Handler): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  private emit(name: string, data: any): void {
    for (const handler of this.handlers.get(name) ?? []) handler(data);
  }

  private rejectLostRequests(): void {
    const queued = new Set(this.queue.map((frame) => JSON.parse(frame).id as number));
    for (const [id, waiter] of this.pending) if (!queued.has(id)) { this.pending.delete(id); waiter.reject(new Error("connection closed before the request completed")); }
  }

  connect(): Promise<{ user: User; connectionId: string }> {
    return new Promise((resolve, reject) => {
      if (!this.reconnectHooksInstalled) {
        this.reconnectHooksInstalled = true;
        addEventListener("online", () => this.reconnectNow());
        document.addEventListener("visibilitychange", () => { if (!document.hidden) this.reconnectNow(); });
      }
      this.openSocket(resolve, reject);
    });
  }

  private openSocket(resolve?: (value: { user: User; connectionId: string }) => void, reject?: (reason: Error) => void): void {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      while (this.queue.length && socket.readyState === WebSocket.OPEN) socket.send(this.queue.shift()!);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.rejectLostRequests();
      this.emit("__closed", null);
      if (this.hasWelcomed) this.scheduleReconnect();
      else reject?.(new Error("could not reach the office server"));
    };
    socket.onerror = () => {
      if (!this.hasWelcomed) reject?.(new Error("could not reach the office server"));
      try { socket.close(); } catch {}
    };
    socket.onmessage = (message) => {
      const frame = JSON.parse(message.data);
      if (frame.type === "event") {
        if (frame.name === "welcome") {
          if (this.hasWelcomed) this.emit("__reconnected", frame.data);
          else { this.hasWelcomed = true; resolve?.(frame.data); }
          this.reconnectDelay = 500;
          return;
        }
        return this.emit(frame.name, frame.data);
      }
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      frame.ok ? waiter.resolve(frame.data) : waiter.reject(new Error(frame.error));
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay + Math.random() * Math.min(this.reconnectDelay * 0.25, 2000);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = null; this.openSocket(); }, delay);
  }

  private reconnectNow(): void {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.openSocket();
  }

  request<T = any>(command: string, args: Record<string, any> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ id, command, args });
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(frame);
      else this.enqueue(frame, command, args);
    });
  }
}

export const api = new Api();
