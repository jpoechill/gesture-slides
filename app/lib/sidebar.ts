export const SIDEBAR_SECTION_IDS = [
  "imageInfo",
  "grid",
  "centerFrame",
  "oval",
  "circle",
  "pose",
  "rectangle",
  "box3d",
  "pencil",
  "adjustImage",
] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];
export type SidebarColumn = "left" | "right";

export const SIDEBAR_DND_SECTION = "application/x-gesture-slideshow-sidebar-section";
export const SIDEBAR_DND_COLUMN = "application/x-gesture-slideshow-sidebar-column";

export const DEFAULT_SIDEBAR_LEFT: SidebarSectionId[] = [
  "imageInfo",
  "oval",
  "grid",
  "centerFrame",
  "circle",
  "rectangle",
  "pose",
  "box3d",
];
export const DEFAULT_SIDEBAR_RIGHT: SidebarSectionId[] = ["adjustImage", "pencil"];

/** Shown only on the Archive tab; all other sections stay on Main. */
export const ARCHIVE_SECTION_IDS = new Set<SidebarSectionId>([
  "grid",
  "centerFrame",
  "box3d",
  "adjustImage",
  "circle",
  "pose",
  "rectangle",
]);

export function sidebarOrderForTab(tab: "main" | "archive", order: SidebarSectionId[]): SidebarSectionId[] {
  return order.filter((id) => (tab === "archive" ? ARCHIVE_SECTION_IDS.has(id) : !ARCHIVE_SECTION_IDS.has(id)));
}

export const SIDEBAR_SECTION_LABEL: Record<SidebarSectionId, string> = {
  imageInfo: "Image info",
  grid: "Grid",
  centerFrame: "Center frame",
  oval: "Oval",
  circle: "Head",
  pose: "Pose (MediaPipe)",
  rectangle: "Rectangle",
  box3d: "3D box",
  pencil: "Pencil",
  adjustImage: "Adjust image",
};

export function isSidebarSectionId(s: string): s is SidebarSectionId {
  return (SIDEBAR_SECTION_IDS as readonly string[]).includes(s);
}

export function normalizeSidebarColumns(
  leftRaw: unknown,
  rightRaw: unknown
): { left: SidebarSectionId[]; right: SidebarSectionId[] } {
  const allowed = new Set<string>(SIDEBAR_SECTION_IDS);
  const parseList = (raw: unknown): SidebarSectionId[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: SidebarSectionId[] = [];
    for (const item of raw) {
      if (typeof item === "string" && allowed.has(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item as SidebarSectionId);
      }
    }
    return out;
  };
  const left = parseList(leftRaw);
  const right = parseList(rightRaw);
  const assigned = new Set<SidebarSectionId>();
  const outLeft: SidebarSectionId[] = [];
  const outRight: SidebarSectionId[] = [];
  for (const id of left) {
    if (!assigned.has(id)) {
      assigned.add(id);
      outLeft.push(id);
    }
  }
  for (const id of right) {
    if (!assigned.has(id)) {
      assigned.add(id);
      outRight.push(id);
    }
  }
  for (const id of SIDEBAR_SECTION_IDS) {
    if (!assigned.has(id)) {
      assigned.add(id);
      if (id === "adjustImage" || id === "pencil") outRight.push(id);
      else outLeft.push(id);
    }
  }
  const leftRank = new Map(DEFAULT_SIDEBAR_LEFT.map((id, i) => [id, i]));
  outLeft.sort((a, b) => (leftRank.get(a) ?? 99) - (leftRank.get(b) ?? 99));
  return { left: outLeft, right: outRight };
}

export function applySidebarDrop(
  left: SidebarSectionId[],
  right: SidebarSectionId[],
  dragId: SidebarSectionId,
  dropId: SidebarSectionId | null,
  fromCol: SidebarColumn,
  toCol: SidebarColumn
): { left: SidebarSectionId[]; right: SidebarSectionId[] } {
  if (dropId === null) {
    if (fromCol === toCol) return { left, right };
    let newLeft = [...left];
    let newRight = [...right];
    if (fromCol === "left") newLeft = newLeft.filter((id) => id !== dragId);
    else newRight = newRight.filter((id) => id !== dragId);
    if (toCol === "left") newLeft = [dragId, ...newLeft];
    else newRight = [dragId, ...newRight];
    return { left: newLeft, right: newRight };
  }
  if (dragId === dropId && fromCol === toCol) return { left, right };
  if (fromCol === toCol) {
    const list = fromCol === "left" ? [...left] : [...right];
    const fi = list.indexOf(dragId);
    const ti = list.indexOf(dropId);
    if (fi === -1 || ti === -1) return { left, right };
    list.splice(fi, 1);
    list.splice(list.indexOf(dropId), 0, dragId);
    return fromCol === "left" ? { left: list, right } : { left, right: list };
  }
  let newLeft = [...left];
  let newRight = [...right];
  if (fromCol === "left") {
    const i = newLeft.indexOf(dragId);
    if (i === -1) return { left, right };
    newLeft.splice(i, 1);
  } else {
    const i = newRight.indexOf(dragId);
    if (i === -1) return { left, right };
    newRight.splice(i, 1);
  }
  if (toCol === "left") {
    const ti = newLeft.indexOf(dropId);
    if (ti === -1) return { left, right };
    newLeft.splice(ti, 0, dragId);
  } else {
    const ti = newRight.indexOf(dropId);
    if (ti === -1) return { left, right };
    newRight.splice(ti, 0, dragId);
  }
  return { left: newLeft, right: newRight };
}
