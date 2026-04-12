"use client";

import dynamic from "next/dynamic";

const SlideshowClient = dynamic(() => import("./SlideshowClient"), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--background)",
        color: "var(--foreground)",
        fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
      }}
    >
      Loading…
    </div>
  ),
});

export default function SlideshowLoader() {
  return <SlideshowClient />;
}
