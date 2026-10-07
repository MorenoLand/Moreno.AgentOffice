import { Terminal } from "@xterm/headless";

const BACKGROUND = "#0d1117";
const FOREGROUND = "#d1d9e0";
const COLORS = ["#282a36", "#ff5c7a", "#7cf29a", "#ffd166", "#6cb6ff", "#d69cff", "#72ddf7", "#e6e6f0", "#6c7086", "#ff8fa3", "#a6f4b8", "#ffe29a", "#9ccfff", "#e5c1ff", "#a5ecfb", "#ffffff"];
const STEPS = [0, 95, 135, 175, 215, 255];
const PALETTE = [...COLORS, ...Array.from({ length: 216 }, (_, index) => `rgb(${STEPS[Math.floor(index / 36)]},${STEPS[Math.floor(index / 6) % 6]},${STEPS[index % 6]})`), ...Array.from({ length: 24 }, (_, index) => { const value = 8 + index * 10; return `rgb(${value},${value},${value})`; })];
export type DesktopVideoRect = { x: number; y: number; width: number; height: number };
export type DesktopPreview = { key: string; title: string; terminal: boolean; snapshot?: HTMLCanvasElement; snapshotId?: number; desktopId?: string; videoRect?: DesktopVideoRect; videoClipRect?: DesktopVideoRect; videoVisibleRects?: DesktopVideoRect[] };

function color(value: number, rgb: boolean, fallback: string): string {
  return rgb ? `#${(value & 0xffffff).toString(16).padStart(6, "0")}` : PALETTE[value] ?? fallback;
}

export class TerminalScreen {
  readonly terminal: Terminal;
  private preview: DesktopPreview | null = null;

  constructor(cols = 100, rows = 28) {
    this.terminal = new Terminal({ cols: Math.max(2, cols), rows: Math.max(2, rows), scrollback: 1000, allowProposedApi: true, theme: { background: BACKGROUND, foreground: FOREGROUND, cursor: "#ffd166" } });
  }

  write(data: string, done: () => void): void {
    this.terminal.write(data, done);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
  }

  setDesktopPreview(preview: DesktopPreview | null): void {
    if (preview && preview.key !== this.preview?.key) this.terminal.reset();
    this.preview = preview;
  }

  paint(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.preview && (this.preview.snapshot || !this.preview.terminal)) { this.paintDesktop(ctx, width, height, this.preview); return; }
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    if (!this.paintTerminal(ctx, 0, 0, width, height)) { ctx.fillStyle = "#6c7086"; ctx.font = `700 ${Math.round(height / 12)}px ui-monospace, Menlo, monospace`; ctx.textAlign = "center"; ctx.fillText("starting…", width / 2, height / 2); ctx.textAlign = "left"; }
  }

  private paintDesktop(ctx: CanvasRenderingContext2D, width: number, height: number, preview: DesktopPreview): void {
    ctx.fillStyle = "#0b1119"; ctx.fillRect(0, 0, width, height);
    if (!preview.snapshot) return;
    const scale = Math.min(width / preview.snapshot.width, height / preview.snapshot.height), drawWidth = preview.snapshot.width * scale, drawHeight = preview.snapshot.height * scale;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(preview.snapshot, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  private paintTerminal(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): boolean {
    const terminal = this.terminal;
    const buffer = terminal.buffer.active;
    const cols = terminal.cols;
    const rows = terminal.rows;
    const left = 0;
    const pad = Math.max(2, width * 0.018);
    const cellW = (width - pad * 2) / cols;
    const lineH = (height - pad * 2) / rows;
    const font = Math.max(2, Math.min(cellW / 0.62, lineH / 1.22));
    let hasText = false;
    ctx.textBaseline = "middle";
    for (let row = 0; row < rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;
      for (let col = 0; col < cols; col++) {
        const cell = line.getCell(left + col);
        if (!cell || cell.getWidth() === 0) continue;
        const cellWidth = Math.max(1, cell.getWidth());
        const px = x + pad + col * cellW;
        const py = y + pad + row * lineH;
        let fg = cell.isFgDefault() ? FOREGROUND : color(cell.getFgColor(), cell.isFgRGB(), FOREGROUND);
        let bg = cell.isBgDefault() ? null : color(cell.getBgColor(), cell.isBgRGB(), BACKGROUND);
        if (cell.isInverse()) [fg, bg] = [bg ?? BACKGROUND, fg];
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(px, py, cellW * cellWidth + 0.5, lineH + 0.5); }
        const chars = cell.getChars();
        if (chars && !cell.isInvisible()) {
          hasText ||= chars.trim().length > 0;
          ctx.globalAlpha = cell.isDim() ? 0.55 : 1;
          ctx.font = `${cell.isItalic() ? "italic " : ""}${cell.isBold() ? 700 : 400} ${font}px ui-monospace, Menlo, Consolas, monospace`;
          ctx.fillStyle = fg;
          ctx.fillText(chars, px, py + lineH / 2, cellW * cellWidth + 1);
          if (cell.isUnderline()) ctx.fillRect(px, py + lineH - 1, cellW * cellWidth, Math.max(1, font / 14));
          ctx.globalAlpha = 1;
        }
        if (buffer.cursorY === row && buffer.cursorX === col) {
          ctx.globalAlpha = 0.7;
          ctx.fillStyle = "#ffd166";
          ctx.fillRect(px, py + lineH * 0.16, Math.max(1, cellW * 0.12), lineH * 0.68);
          ctx.globalAlpha = 1;
        }
      }
    }
    return hasText;
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
