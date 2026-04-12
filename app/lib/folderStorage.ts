export const LAST_FOLDER_NAME_KEY = "gesture-slideshow-last-folder-name";
export const LAST_FOLDER_OPENED_AT_KEY = "gesture-slideshow-last-folder-opened-at";
const IDB_NAME = "gesture-slideshow";
const IDB_STORE = "handles";
const IDB_LAST_FOLDER_KEY = "last-folder";

export function getLastFolderName(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(LAST_FOLDER_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setLastFolderName(name: string) {
  if (typeof window === "undefined") return;
  try {
    if (name) localStorage.setItem(LAST_FOLDER_NAME_KEY, name);
    else localStorage.removeItem(LAST_FOLDER_NAME_KEY);
  } catch {
    /* ignore */
  }
}

export function getLastFolderOpenedAt(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_FOLDER_OPENED_AT_KEY);
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function setLastFolderOpenedAt(ms: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAST_FOLDER_OPENED_AT_KEY, String(ms));
  } catch {
    /* ignore */
  }
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
  });
}

export async function saveLastFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, IDB_LAST_FOLDER_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLastFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_LAST_FOLDER_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
