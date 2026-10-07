export type AppOrderLayout = "row" | "column";

export function enableAppOrdering(container: HTMLElement, storageKey: string, layout: AppOrderLayout, holdToDrag = false, legacyStorageKey?: string, gridColumnsHint?: number, fitViewport = false): () => void {
  const items = () => Array.from(container.children).filter((item): item is HTMLElement => item instanceof HTMLElement && !!item.dataset.appOrderId);
  const appItems = items();
  const measure = () => {
    const style = getComputedStyle(container), parseTracks = (value: string) => value.split(/\s+/).map((track) => Number.parseFloat(track)).filter((size) => Number.isFinite(size) && size > 0);
    const columns = parseTracks(style.gridTemplateColumns), rows = parseTracks(style.gridTemplateRows), gapX = Number.parseFloat(style.columnGap) || 0, gapY = Number.parseFloat(style.rowGap) || 0;
    const currentItems = items(), uniqueXs = [...new Set(currentItems.map((item) => Math.round(item.getBoundingClientRect().left)))];
    const count = columns.length || (fitViewport ? gridColumnsHint : uniqueXs.length) || uniqueXs.length || gridColumnsHint || (layout === "column" ? 1 : Math.max(1, currentItems.length));
    const cellWidth = columns[0] || Math.max(1, currentItems[0]?.getBoundingClientRect().width ?? 1), cellHeight = rows[0] || Math.max(1, ...currentItems.map((item) => item.getBoundingClientRect().height));
    const rect = container.getBoundingClientRect(), left = rect.left + container.clientLeft + (Number.parseFloat(style.paddingLeft) || 0), top = rect.top + container.clientTop + (Number.parseFloat(style.paddingTop) || 0);
    return { count, columns, rows, gapX, gapY, cellWidth, cellHeight, left, top };
  };
  let metrics = measure();
  let positions = new Map<string, number>();
  const parseSaved = (raw: string | null): { positions?: Record<string, number>; order?: unknown[]; columns?: number } | undefined => {
    try {
      const value = JSON.parse(raw ?? "null");
      if (Array.isArray(value)) return { order: value };
      if (value && value.version === 2 && value.positions && typeof value.positions === "object") return { positions: value.positions, columns: Number.isInteger(value.columns) && value.columns > 0 ? value.columns : undefined };
    } catch {}
    return undefined;
  };
  let saved: ReturnType<typeof parseSaved>;
  try { saved = parseSaved(localStorage.getItem(storageKey)); if (!saved && legacyStorageKey) saved = parseSaved(localStorage.getItem(legacyStorageKey)); } catch {}
  if (saved?.positions) {
    for (const item of appItems) {
      const id = item.dataset.appOrderId!, cell = saved.positions[id];
      if (Number.isInteger(cell) && cell >= 0 && ![...positions.values()].includes(cell)) positions.set(id, cell);
    }
  }
  if (saved?.order) {
    const order = new Map(saved.order.filter((id): id is string => typeof id === "string").map((id, index) => [id, index]));
    appItems.sort((a, b) => (order.get(a.dataset.appOrderId!) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.dataset.appOrderId!) ?? Number.MAX_SAFE_INTEGER));
  }
  let nextCell = 0;
  for (const [index, item] of appItems.entries()) {
    const id = item.dataset.appOrderId!;
    if (!positions.has(id)) { if (fitViewport && !saved?.positions && layout === "column") nextCell = index % Math.max(1, metrics.rows.length) * metrics.count + Math.floor(index / Math.max(1, metrics.rows.length)); while ([...positions.values()].includes(nextCell)) nextCell++; positions.set(id, nextCell++); }
  }
  let preferred = new Map([...positions].map(([id, cell]) => [id, { column: cell % (saved?.columns ?? metrics.count), row: Math.floor(cell / (saved?.columns ?? metrics.count)) }]));
  const fit = () => {
    if (!fitViewport) return;
    const count = metrics.count, rows = Math.max(1, metrics.rows.length), occupied = new Set<number>(), pending: string[] = [];
    positions = new Map();
    for (const item of items()) { const id = item.dataset.appOrderId!, target = preferred.get(id) ?? { column: 0, row: 0 }, cell = Math.min(rows - 1, target.row) * count + Math.min(count - 1, target.column); if (occupied.has(cell)) pending.push(id); else { positions.set(id, cell); occupied.add(cell); } }
    for (const id of pending) { let cell = 0; while (occupied.has(cell)) cell++; positions.set(id, cell); occupied.add(cell); }
  };
  const persist = () => { if (fitViewport) preferred = new Map([...positions].map(([id, cell]) => [id, { column: cell % metrics.count, row: Math.floor(cell / metrics.count) }])); try { localStorage.setItem(storageKey, JSON.stringify({ version: 2, positions: Object.fromEntries(positions), ...(fitViewport ? { columns: metrics.count } : {}) })); } catch {} };
  const apply = () => {
    for (const item of items()) {
      const cell = positions.get(item.dataset.appOrderId!) ?? 0;
      item.style.gridColumn = String(cell % metrics.count + 1);
      item.style.gridRow = String(Math.floor(cell / metrics.count) + 1);
    }
  };
  const refresh = () => { metrics = measure(); fit(); apply(); if (fitViewport) container.scrollTop = container.scrollLeft = 0; };
  refresh();
  requestAnimationFrame(() => { if (container.isConnected) refresh(); });
  if (fitViewport) new ResizeObserver(refresh).observe(container);
  if (!saved?.positions) persist();
  container.style.touchAction = "none";
  let gesture: { item: HTMLElement; pointerId: number; x: number; y: number; armed: boolean; started: boolean; timer: number; cell?: number; target?: HTMLElement } | undefined;
  let suppressClick: HTMLElement | undefined;
  const cellAt = (x: number, y: number): number | undefined => {
    metrics = measure();
    const rect = container.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return undefined;
    const col = Math.max(0, Math.min(metrics.count - 1, Math.floor((x - metrics.left) / (metrics.cellWidth + metrics.gapX))));
    const knownRows = metrics.rows.length, row = knownRows && y <= metrics.top + metrics.rows.reduce((sum, size, index) => sum + size + (index ? metrics.gapY : 0), 0)
      ? metrics.rows.findIndex((size, index) => y < metrics.top + metrics.rows.slice(0, index).reduce((sum, value) => sum + value + metrics.gapY, 0) + size)
      : Math.max(0, Math.floor((y - metrics.top) / (metrics.cellHeight + metrics.gapY)));
    return Math.max(0, row) * metrics.count + col;
  };
  container.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const item = (event.target as Element).closest<HTMLElement>("[data-app-order-id]");
    if (!item || item.parentElement !== container) return;
    suppressClick = undefined;
    const current = gesture = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, armed: !holdToDrag || event.pointerType !== "touch", started: false, timer: 0 };
    if (!current.armed) current.timer = window.setTimeout(() => { if (gesture === current) current.armed = true; }, 260);
  });
  container.addEventListener("pointermove", (event) => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId || Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8) return;
    if (!current.armed) { clearTimeout(current.timer); gesture = undefined; return; }
    if (!current.started) { current.started = true; current.item.classList.add("app-order-dragging"); try { container.setPointerCapture(event.pointerId); } catch {} }
    event.preventDefault();
    const cell = cellAt(event.clientX, event.clientY);
    if (cell === undefined) return;
    current.cell = cell;
    current.target = items().find((item) => item !== current.item && positions.get(item.dataset.appOrderId!) === cell);
    items().forEach((item) => item.classList.toggle("app-order-drop-target", item === current.target));
  });
  const finish = (event: PointerEvent) => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId) return;
    clearTimeout(current.timer);
    if (current.started) {
      current.item.classList.remove("app-order-dragging");
      items().forEach((item) => item.classList.remove("app-order-drop-target"));
      if (current.cell !== undefined) {
        const id = current.item.dataset.appOrderId!, from = positions.get(id) ?? 0, occupant = items().find((item) => item !== current.item && positions.get(item.dataset.appOrderId!) === current.cell);
        if (occupant) positions.set(occupant.dataset.appOrderId!, from);
        positions.set(id, current.cell);
        persist(); apply();
      }
      suppressClick = current.item;
    }
    gesture = undefined;
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", finish);
  container.addEventListener("click", (event) => {
    if (!suppressClick || !(event.target instanceof Element) || !suppressClick.contains(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation(); suppressClick = undefined;
  }, true);
  return refresh;
}
