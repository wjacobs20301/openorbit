import { idb, STORES } from './idb';

/**
 * Files the user chose to keep in My Places, stored in IndexedDB (localStorage is too
 * small for typical KML/shapefile sizes) so they reopen on the next start.
 */

export interface KeptFile {
  id: string;
  name: string;
  files: { name: string; type: string; data: Blob }[];
}

const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => idb(STORES.keptFiles, mode, fn);

export async function keepFiles(name: string, files: File[]): Promise<string> {
  const id = crypto.randomUUID();
  await run('readwrite', (s) => s.put({ id, name, files: files.map((f) => ({ name: f.name, type: f.type, data: f })) }));
  return id;
}

export function forgetFiles(id: string): Promise<undefined> {
  return run('readwrite', (s) => s.delete(id));
}

export async function keptFiles(): Promise<KeptFile[]> {
  try {
    return await run<KeptFile[]>('readonly', (s) => s.getAll());
  } catch {
    // Storage can be unavailable (private mode); nothing was kept then.
    return [];
  }
}
