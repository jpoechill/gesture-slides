export type TimerMode = "classic" | "loop";

export function parseTimerMode(v: unknown): TimerMode {
  return v === "classic" ? "classic" : "loop";
}

/** Classic: each tier has a slot budget; the selected preset is the active interval; one completion = −1 on that tier. */
export const CLASSIC_PRESETS = [
  { sec: 30, slots: 20, shortLabel: "30s" },
  { sec: 60, slots: 10, shortLabel: "1m" },
  { sec: 180, slots: 10, shortLabel: "3m" },
  { sec: 300, slots: 10, shortLabel: "5m" },
  { sec: 600, slots: 5, shortLabel: "10m" },
  { sec: 900, slots: 1, shortLabel: "15m" },
] as const;

export type ClassicTierSec = (typeof CLASSIC_PRESETS)[number]["sec"];
export type ClassicSlots = Record<ClassicTierSec, number>;

export const CLASSIC_TIER_SEC = CLASSIC_PRESETS.map((p) => p.sec) as readonly ClassicTierSec[];
const CLASSIC_TIER_SET = new Set<number>(CLASSIC_TIER_SEC);

export function isClassicTierSec(n: number): n is ClassicTierSec {
  return CLASSIC_TIER_SET.has(n);
}

export const CLASSIC_SLOTS_INITIAL: ClassicSlots = Object.fromEntries(
  CLASSIC_PRESETS.map((p) => [p.sec, p.slots])
) as ClassicSlots;

export const CLASSIC_STEP_TOTAL = CLASSIC_PRESETS.reduce((sum, p) => sum + p.slots, 0);
export const CLASSIC_FIRST_TIER = CLASSIC_PRESETS[0]!.sec;
export const CLASSIC_EXHAUSTED_PLACEHOLDER_SEC = CLASSIC_PRESETS[CLASSIC_PRESETS.length - 1]!.sec;

export function classicSlotsRemainingTotal(s: ClassicSlots): number {
  let n = 0;
  for (const t of CLASSIC_TIER_SEC) n += s[t];
  return n;
}

export function classicSlotsExhausted(s: ClassicSlots): boolean {
  return classicSlotsRemainingTotal(s) === 0;
}

export function classicCompletedCount(s: ClassicSlots): number {
  return CLASSIC_STEP_TOTAL - classicSlotsRemainingTotal(s);
}

export function classicIntervalButtonLabels(slots: ClassicSlots): { sec: number; label: string }[] {
  return CLASSIC_PRESETS.map((p) => ({
    sec: p.sec,
    label: `${p.shortLabel} x ${slots[p.sec]}`,
  }));
}

export const CLASSIC_MODE_TOOLTIP = `Classic: ${CLASSIC_PRESETS.map((p) => `${p.slots}×${p.shortLabel}`).join(", ")} — click a preset for the timer; each finished interval uses one slot on that tier. Session ends when every tier is 0. Loop: one interval for all slides.`;

export const LOOP_INTERVAL_PRESETS: [number, string][] = [
  [15, "15s"],
  [30, "30s"],
  [60, "1m"],
  [120, "2m"],
  [180, "3m"],
  [300, "5m"],
  [600, "10m"],
  [900, "15m"],
  [1200, "20m"],
  [1800, "30m"],
  [3600, "1h"],
];
