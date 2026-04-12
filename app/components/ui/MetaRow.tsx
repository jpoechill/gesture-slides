export function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ opacity: 0.6, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </span>
      <span style={{ opacity: 0.95, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
