import * as THREE from "three";
import type { Avatar } from "./api";

export interface ChatMessage {
  connectionId: string;
  username: string;
  displayName: string;
  color: string;
  text: string;
  sentAt: number;
}

interface Bubble {
  node: HTMLElement;
  timer: number;
}

export class ChatDisplay {
  private readonly log = document.createElement("div");
  private readonly layer = document.createElement("div");
  private readonly positions = new Map<string, { x: number; y: number; z: number }>();
  private readonly bubbles = new Map<string, Bubble>();
  private readonly point = new THREE.Vector3();
  private showBubbles = true;

  constructor() {
    this.log.id = "chat-log";
    this.layer.id = "chat-bubbles";
    document.body.append(this.log, this.layer);
  }

  syncAvatars(avatars: Avatar[]): void {
    this.positions.clear();
    for (const avatar of avatars) this.positions.set(avatar.connectionId, { x: avatar.x, y: avatar.y, z: avatar.z });
  }

  moveAvatar(avatar: Avatar): void {
    this.positions.set(avatar.connectionId, { x: avatar.x, y: avatar.y, z: avatar.z });
  }

  setBubblesVisible(visible: boolean): void {
    this.showBubbles = visible;
    for (const bubble of this.bubbles.values()) bubble.node.hidden = !visible;
  }

  receive(message: ChatMessage): void {
    const line = document.createElement("div");
    line.className = "chat-line";
    const name = document.createElement("strong");
    name.textContent = message.displayName;
    name.style.color = message.color;
    const text = document.createElement("span");
    text.textContent = message.text;
    line.append(name, text);
    this.log.appendChild(line);
    while (this.log.childElementCount > 8) this.log.firstElementChild?.remove();
    window.setTimeout(() => line.classList.add("fading"), 8000);
    window.setTimeout(() => line.remove(), 10000);

    if (!this.showBubbles) return;
    const previous = this.bubbles.get(message.connectionId);
    if (previous) {
      window.clearTimeout(previous.timer);
      previous.node.remove();
    }
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = message.text;
    this.layer.appendChild(bubble);
    const timer = window.setTimeout(() => {
      bubble.classList.add("fading");
      window.setTimeout(() => {
        bubble.remove();
        if (this.bubbles.get(message.connectionId)?.node === bubble) this.bubbles.delete(message.connectionId);
      }, 500);
    }, 4500);
    this.bubbles.set(message.connectionId, { node: bubble, timer });
  }

  update(camera: THREE.Camera, selfId: string, self: { x: number; y: number; z: number; seated: boolean }): void {
    for (const [id, bubble] of this.bubbles) {
      if (!this.showBubbles) { bubble.node.hidden = true; continue; }
      const position = id === selfId ? self : this.positions.get(id);
      if (!position) {
        bubble.node.hidden = true;
        continue;
      }
      this.point.set(position.x, position.y + (id === selfId ? self.seated ? 1.31 : 1.56 : 1.56), position.z).project(camera);
      bubble.node.hidden = this.point.z < -1 || this.point.z > 1 || Math.abs(this.point.x) > 1.2 || Math.abs(this.point.y) > 1.2;
      if (bubble.node.hidden) continue;
      bubble.node.style.left = `${(this.point.x + 1) * innerWidth / 2}px`;
      bubble.node.style.top = `${(1 - this.point.y) * innerHeight / 2}px`;
    }
  }
}
