import type { WallPoint } from "./wall_art";

type NoteStroke = { color: string; points: [number, number][] };
type NoteValue = { text: string; strokes: NoteStroke[]; position?: WallPoint };

function parseNote(value: string): NoteValue {
  try {
    const data = JSON.parse(value) as Partial<NoteValue>;
    if (typeof data.text === "string" && Array.isArray(data.strokes)) {
      const position = data.position && ["north", "south", "east", "west"].includes(data.position.wall) && Number.isFinite(data.position.u) && Number.isFinite(data.position.y) ? data.position as WallPoint : undefined;
      return { text: data.text, strokes: data.strokes.filter((stroke) => /^#[\da-f]{6}$/i.test(stroke.color) && Array.isArray(stroke.points)).slice(0, 80), ...(position ? { position } : {}) };
    }
  } catch {}
  return { text: value, strokes: [] };
}

export class StickyNoteEditor {
  private dialog = document.createElement("dialog");
  private title: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private color: HTMLSelectElement;
  private index = -1;
  private position?: WallPoint;
  private strokes: NoteStroke[] = [];
  private currentStroke: NoteStroke | null = null;

  constructor(private readOnly: boolean, private save: (index: number, text: string) => void) {
    this.dialog.className = "sticky-note-dialog";
    this.dialog.innerHTML = `<form><header><strong></strong><button type="button" data-close aria-label="Close">×</button></header><textarea maxlength="240" aria-label="Sticky note text" placeholder="Type a note"></textarea><div class="sticky-note-tools"><label>Pen <select data-color><option value="#34495e">Ink</option><option value="#c0392b">Red</option><option value="#2678bb">Blue</option><option value="#25845d">Green</option></select></label><button type="button" data-clear>Clear drawing</button></div><canvas width="480" height="520" aria-label="Draw on this sticky note"></canvas><footer><button type="button" data-cancel>Cancel</button><button type="submit" data-save>Save note</button></footer></form>`;
    this.title = this.dialog.querySelector("strong")!;
    this.textarea = this.dialog.querySelector("textarea")!;
    this.canvas = this.dialog.querySelector("canvas")!;
    this.context = this.canvas.getContext("2d")!;
    this.color = this.dialog.querySelector("[data-color]")!;
    this.textarea.readOnly = readOnly;
    this.color.disabled = readOnly;
    this.dialog.querySelector<HTMLButtonElement>("[data-save]")!.hidden = readOnly;
    this.dialog.querySelector("[data-close]")!.addEventListener("click", () => this.dialog.close());
    this.dialog.querySelector("[data-cancel]")!.addEventListener("click", () => this.dialog.close());
    this.dialog.querySelector("[data-clear]")!.addEventListener("click", () => { this.strokes = []; this.draw(); });
    this.dialog.querySelector("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.readOnly && this.index >= 0) this.save(this.index, JSON.stringify({ text: this.textarea.value.slice(0, 240), strokes: this.strokes, ...(this.position ? { position: this.position } : {}) }));
      this.dialog.close();
    });
    this.canvas.addEventListener("pointerdown", (event) => {
      if (this.readOnly) return;
      event.preventDefault();
      if (this.strokes.length >= 14) this.strokes.shift();
      const stroke = { color: this.color.value, points: [this.point(event)] as [number, number][] };
      this.strokes.push(stroke);
      this.currentStroke = stroke;
      this.canvas.setPointerCapture(event.pointerId);
      this.draw();
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.currentStroke) return;
      event.preventDefault();
      if (this.currentStroke.points.length < 200) this.currentStroke.points.push(this.point(event));
      this.draw();
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) this.canvas.addEventListener(name, () => { this.currentStroke = null; });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    document.body.append(this.dialog);
  }

  get isOpen(): boolean { return this.dialog.open; }
  close(): void { this.dialog.close(); }

  open(index: number, value: string, position?: WallPoint): void {
    const data = parseNote(value);
    this.index = index;
    this.position = position ?? data.position;
    this.title.textContent = `Sticky note ${index + 1}`;
    this.textarea.value = data.text;
    this.strokes = data.strokes;
    this.draw();
    this.dialog.showModal();
    if (!this.readOnly) this.textarea.focus();
  }

  private point(event: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 1000), Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * 1000)];
  }

  private draw(): void {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const stroke of this.strokes) {
      if (!stroke.points.length) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      stroke.points.forEach(([x, y], i) => i ? ctx.lineTo(x * this.canvas.width / 1000, y * this.canvas.height / 1000) : ctx.moveTo(x * this.canvas.width / 1000, y * this.canvas.height / 1000));
      ctx.stroke();
    }
  }
}
