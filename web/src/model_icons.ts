export const modelIconOptions = [
  { id: "", label: "Accent" },
  { id: "codex", label: "Codex" },
  { id: "claude-color", label: "Claude" },
  { id: "gemini-color", label: "Gemini" },
  { id: "grok-color", label: "Grok" },
  { id: "zai", label: "Z.ai" }
] as const;

export const OWNER_LAPTOP_ICON_KEY = "agent-office-owner-laptop-icon";

export function defaultModelIcon(profileId: string): string {
  return profileId === "codex" ? "codex" : profileId === "claude" ? "claude-color" : "";
}

export function modelIconPath(id: string): string {
  if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(id)) return id;
  return modelIconOptions.some((option) => option.id === id && id !== "") ? `/model-icons/${id}.svg` : "";
}

export function isCustomLaptopIcon(id: string): boolean { return /^data:image\/(?:png|jpeg|webp);base64,/i.test(id); }

export function readCustomLaptopIcon(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return Promise.reject(new Error("Choose a PNG, JPEG, or WebP image."));
  if (file.size > 512 * 1024) return Promise.reject(new Error("Laptop icons must be 512 KB or smaller."));
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that image.")); reader.onerror = () => reject(new Error("Could not read that image.")); reader.readAsDataURL(file); });
}
