export function SliderRow({
  label,
  value,
  min,
  max,
  step = 0.01,
  format = (v: number) => String(v),
  onChange,
  onRangePointerDown,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** Snapshot before a drag on the range (e.g. undo stack). */
  onRangePointerDown?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ opacity: 0.85, fontSize: 12 }}>{label}</span>
        <span style={{ opacity: 0.7, fontSize: 11 }}>{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onRangePointerDown}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          width: "100%",
          accentColor: "rgba(255,255,255,0.8)",
        }}
      />
    </div>
  );
}
