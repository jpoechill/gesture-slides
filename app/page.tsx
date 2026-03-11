"use client"

import React, { useEffect, useMemo, useRef, useState } from "react";

type FileHandleEntry = {
  name: string;
  handle: FileSystemFileHandle;
};

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]);

function isImageFileName(name: string) {
  const lower = name.toLowerCase();
  for (const ext of IMAGE_EXTS) if (lower.endsWith(ext)) return true;
  return false;
}

function shuffle<T>(array: T[]) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Page() {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<FileHandleEntry[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [idxInOrder, setIdxInOrder] = useState(0);

  const [isRunning, setIsRunning] = useState(false);
  const [intervalSec, setIntervalSec] = useState(60);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const countdownRef = useRef<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  const currentFile = useMemo(() => {
    if (!files.length || !order.length) return null;
    const fileIndex = order[idxInOrder % order.length];
    return files[fileIndex] || null;
  }, [files, order, idxInOrder]);

  async function collectImagesRecursive(
    dir: FileSystemDirectoryHandle,
    pathPrefix: string
  ): Promise<FileHandleEntry[]> {
    const collected: FileHandleEntry[] = [];
    // @ts-expect-error: values() exists on FileSystemDirectoryHandle but types may be incomplete
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && isImageFileName(entry.name)) {
        collected.push({ name: pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name, handle: entry });
      } else if (entry.kind === "directory") {
        const subPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        const subFiles = await collectImagesRecursive(entry, subPath);
        collected.push(...subFiles);
      }
    }
    return collected;
  }

  async function pickFolder() {
    try {
      // @ts-expect-error: showDirectoryPicker types exist in newer TS libs; safe in Chromium
      const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker();
      setDirHandle(handle);

      const collected = await collectImagesRecursive(handle, "");

      if (!collected.length) {
        alert("No images found in that folder. Try a folder with .jpg/.png/.webp etc.");
        setFiles([]);
        setOrder([]);
        setIdxInOrder(0);
        setIsRunning(false);
        return;
      }

      setFiles(collected);
      setOrder(shuffle(collected.map((_, i) => i)));
      setIdxInOrder(0);
      setIsRunning(true);
    } catch (e) {
      console.warn(e);
    }
  }

  function reshuffle() {
    if (!files.length) return;
    setOrder(shuffle(files.map((_, i) => i)));
    setIdxInOrder(0);
  }

  function next() {
    if (!order.length) return;
    setIdxInOrder((v) => (v + 1) % order.length);
  }

  function prev() {
    if (!order.length) return;
    setIdxInOrder((v) => (v - 1 + order.length) % order.length);
  }

  async function enterFullscreen() {
    if (!imageContainerRef.current) return;
    try {
      if (imageContainerRef.current.requestFullscreen) {
        await imageContainerRef.current.requestFullscreen();
      }
    } catch (e) {
      console.warn("Failed to enter fullscreen:", e);
    }
  }

  async function exitFullscreen() {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch (e) {
      console.warn("Failed to exit fullscreen:", e);
    }
  }

  function toggleFullscreen() {
    if (isFullscreen) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }

  // Load/display current image
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!currentFile) return;

      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }

      const file = await currentFile.handle.getFile();
      const url = URL.createObjectURL(file);

      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }

      currentUrlRef.current = url;
      setCurrentUrl(url);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [currentFile]);

  // Timer logic
  useEffect(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (isRunning && order.length) {
      setTimeRemaining(intervalSec);
      timerRef.current = window.setInterval(() => {
        setIdxInOrder((v) => (v + 1) % order.length);
      }, Math.max(1, intervalSec) * 1000);
    } else {
      setTimeRemaining(0);
    }

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [isRunning, intervalSec, order.length]);

  // Countdown timer
  useEffect(() => {
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (isRunning && order.length) {
      // Reset timer when image changes or when starting
      setTimeRemaining(intervalSec);
      countdownRef.current = window.setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            return intervalSec;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      setTimeRemaining(0);
    }

    return () => {
      if (countdownRef.current) window.clearInterval(countdownRef.current);
    };
  }, [isRunning, intervalSec, order.length, idxInOrder]);

  // Fullscreen state tracking
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // Keyboard controls
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!files.length || !order.length) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdxInOrder((v) => (v - 1 + order.length) % order.length);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIdxInOrder((v) => (v + 1) % order.length);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [files.length, order.length]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
    };
  }, []);

  const canRun = files.length > 0;

  return (
    <div
      ref={containerRef}
      style={{
        minHeight: "100vh",
        height: currentUrl ? "100vh" : "auto",
        width: "100%",
        background: "#0b1220",
        color: "white",
        position: "relative",
        overflow: currentUrl ? "hidden" : "visible",
      }}
    >
      {!currentUrl ? (
        // Landing page
        <div style={{
          maxWidth: 600,
          margin: "0 auto",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: 40,
          textAlign: "center",
        }}>
          <h1 style={{ margin: "0 0 12px", fontSize: 32, fontWeight: 500, opacity: 0.95 }}>
            Gesture Slideshow
          </h1>
          <p style={{ margin: "0 0 32px", fontSize: 16, opacity: 0.7, lineHeight: 1.5 }}>
            Pick a folder → images shuffle → auto-advance
          </p>

          {!supported && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                background: "rgba(255,255,255,0.05)",
                marginBottom: 24,
                fontSize: 14,
                opacity: 0.8,
              }}
            >
              Your browser doesn't support folder picking. Use Chrome/Edge on desktop.
            </div>
          )}

          <button
            onClick={pickFolder}
            disabled={!supported}
            style={{
              ...btn(!supported),
              padding: "14px 28px",
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            Pick Folder
          </button>
        </div>
      ) : (
        // Image view with controls
        <div style={{
          maxWidth: currentUrl ? "100%" : 1200,
          width: currentUrl ? "100%" : "auto",
          margin: currentUrl ? 0 : "0 auto",
          height: currentUrl ? "100vh" : "auto",
          minHeight: currentUrl ? "100vh" : "auto",
          display: "flex",
          flexDirection: "column",
          padding: currentUrl ? 0 : 20
        }}>
          <div
            style={{
              padding: currentUrl ? "20px 20px 0" : "0 0 20px",
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              opacity: 1,
              position: currentUrl ? "absolute" : "relative",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 10,
            }}
          >
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 500, opacity: 0.9 }}>
              Gesture Slideshow
            </h1>
            <span style={{ fontSize: 13, opacity: 0.6 }}>
              Pick a folder → images shuffle → auto-advance
            </span>
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: currentUrl ? "flex-end" : "flex-start",
              marginBottom: currentUrl ? 0 : 20,
              padding: currentUrl ? "20px 20px 0 0" : 0,
              opacity: 1,
              position: currentUrl ? "absolute" : "relative",
              top: currentUrl ? 0 : "auto",
              right: currentUrl ? 0 : "auto",
              left: currentUrl ? "auto" : "auto",
              bottom: currentUrl ? "auto" : "auto",
              zIndex: 10,
            }}
          >
            <button onClick={pickFolder} disabled={!supported} style={btn(!supported)}>
              {dirHandle ? "Change Folder" : "Pick Folder"}
            </button>

            <button onClick={() => setIsRunning(true)} disabled={!canRun} style={btn(!canRun)}>
              Start
            </button>
            <button onClick={() => setIsRunning(false)} disabled={!canRun} style={btn(!canRun)}>
              Pause
            </button>

            <button onClick={prev} disabled={!canRun} style={btn(!canRun)}>
              ←
            </button>
            <button onClick={next} disabled={!canRun} style={btn(!canRun)}>
              →
            </button>

            <button onClick={reshuffle} disabled={!canRun} style={btn(!canRun)}>
              ↻
            </button>

            <button onClick={toggleFullscreen} disabled={!canRun} style={btn(!canRun)}>
              ⛶
            </button>

            <label style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>Interval:</span>
              <input
                type="number"
                min={1}
                value={intervalSec}
                onChange={(e) => setIntervalSec(parseInt(e.target.value || "60", 10))}
                style={{
                  width: 60,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "rgba(255,255,255,0.05)",
                  color: "white",
                  fontSize: 13,
                }}
              />
              <span style={{ opacity: 0.7, fontSize: 13 }}>s</span>
            </label>

            {isRunning && timeRemaining > 0 && (
              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.08)",
                  fontSize: 13,
                  opacity: 0.9,
                }}
              >
                {timeRemaining}s
              </div>
            )}

            <div style={{ marginLeft: "auto", opacity: 0.7, fontSize: 13 }}>
              {files.length ? (
                <>
                  {idxInOrder + 1}/{order.length}
                </>
              ) : null}
            </div>
          </div>

          <div
            ref={imageContainerRef}
            style={{
              borderRadius: isFullscreen ? 0 : 12,
              overflow: "hidden",
              border: isFullscreen ? "none" : "none",
              background: isFullscreen ? "#0b1220" : "#0b1220",
              minHeight: isFullscreen ? "100vh" : "100vh",
              width: isFullscreen ? "100vw" : "100vw",
              height: isFullscreen ? "100vh" : "100vh",
              flex: 1,
              display: "grid",
              placeItems: "center",
              position: "relative",
            }}
          >
            <img
              src={currentUrl}
              alt={currentFile?.name || "gesture"}
              onClick={toggleFullscreen}
              style={{
                maxWidth: "100vw",
                maxHeight: "100vh",
                width: "auto",
                height: "auto",
                objectFit: "contain",
                display: "block",
                background: "black",
                cursor: "pointer",
              }}
            />
            {isFullscreen && isRunning && timeRemaining > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: 20,
                  right: 20,
                  padding: "8px 16px",
                  borderRadius: 8,
                  background: "rgba(0, 0, 0, 0.7)",
                  backdropFilter: "blur(8px)",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  fontSize: 18,
                  fontWeight: 600,
                  color: "white",
                  minWidth: 50,
                  textAlign: "center",
                }}
              >
                {timeRemaining}s
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function btn(disabled = false): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.12)",
    background: disabled ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.08)",
    color: "white",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 0.9,
    fontWeight: 500,
    fontSize: 13,
    transition: "opacity 0.2s",
  };
}
