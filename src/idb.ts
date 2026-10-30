/**
 * The app's IndexedDB database, for things too big for localStorage: kept files and
 * image overlay pictures.
 */

const DB = 'openorbit';
const VERSION = 2;
export const STORES = { keptFiles: 'keptFiles', overlayImages: 'overlayImages' } as const;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.keptFiles)) db.createObjectStore(STORES.keptFiles, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.overlayImages)) db.createObjectStore(STORES.overlayImages);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs one request against a store and resolves with its result. */
export async function idb<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
