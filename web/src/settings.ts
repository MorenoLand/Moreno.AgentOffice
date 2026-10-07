export type OfficeSettingsState = {
  deskMarkers: boolean;
  playerNameplates: boolean;
  chatBubbles: boolean;
  footsteps: boolean;
  officeAmbience: boolean;
};

export const defaultOfficeSettings: Readonly<OfficeSettingsState> = Object.freeze({ deskMarkers: true, playerNameplates: true, chatBubbles: true, footsteps: true, officeAmbience: true });

const storageKey = "agent-office-settings";
const settingRows: Array<{ key: keyof OfficeSettingsState; label: string }> = [
  { key: "deskMarkers", label: "Available desk markers" },
  { key: "playerNameplates", label: "Player nameplates" },
  { key: "chatBubbles", label: "Chat bubbles" },
  { key: "footsteps", label: "Footsteps" },
  { key: "officeAmbience", label: "Office ambience" },
];

export class OfficeSettingsPanel {
  private readonly state: OfficeSettingsState;

  constructor(private readonly onChange: (settings: OfficeSettingsState) => void, initial: Partial<OfficeSettingsState> = {}) {
    this.state = { ...defaultOfficeSettings, ...this.readStored(), ...initial };
  }

  getSettings(): OfficeSettingsState { return { ...this.state }; }
  setSetting(key: keyof OfficeSettingsState, value: boolean): void { if (this.state[key] === value) return; this.state[key] = value; this.persist(); this.onChange(this.getSettings()); }

  private readStored(): Partial<OfficeSettingsState> {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      if (!parsed || typeof parsed !== "object") return {};
      const stored = parsed as Record<string, unknown>;
      return Object.fromEntries(settingRows.filter(({ key }) => typeof stored[key] === "boolean").map(({ key }) => [key, stored[key]])) as Partial<OfficeSettingsState>;
    } catch { return {}; }
  }

  private persist(): void {
    try { window.localStorage.setItem(storageKey, JSON.stringify(this.state)); } catch {}
  }
}
