// estorageClient.ts
// Simple client for the FastAPI estorage server.

export const backend = "";

export type DirEntry =
    | { type: "dir"; name: string }
    | { type: "file"; name: string; sha256: string };

function ensureOk(res: Response, label: string) {
    if (!res.ok) {
        throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
    }
}

function encodePath(path: string) {
    // Keep slashes but encode each segment
    const trimmed = String(path || "").replace(/^\/+/, "");
    if (!trimmed) return "";
    return trimmed
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
}

/**
 * GET /estorage
 * Returns array of DB names.
 */
export async function listDBs(opts?: { signal?: AbortSignal }): Promise<string[]> {
    const url = `${backend}/estorage`;
    const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        signal: opts?.signal,
    });
    ensureOk(res, "listDBs");
    return (await res.json()) as string[];
}

/**
 * POST /estorage/{dbName}
 * Upload a zip file (multipart form field name: "file").
 */
export async function uploadDBZip(
    dbName: string,
    zip: File | Blob,
    opts?: { signal?: AbortSignal }
): Promise<{ ok: boolean; db: string }> {
    const url = `${backend}/estorage/${encodeURIComponent(dbName)}`;
    const form = new FormData();
    form.append("file", zip, (zip as any).name ?? "export.zip");

    const res = await fetch(url, {
        method: "POST",
        body: form,
        credentials: "include",
        signal: opts?.signal,
    });
    ensureOk(res, "uploadDBZip");
    return (await res.json()) as { ok: boolean; db: string };
}

/**
 * GET /estorage/{dbName}/{path}
 * If `path` is a dir -> returns DirEntry[]
 * If `path` is a file -> you should use downloadDBFile / fetchDBFileBytes / fetchDBFileText
 */
export async function listDBDir(
    dbName: string,
    path: string,
    opts?: { signal?: AbortSignal }
): Promise<DirEntry[]> {
    const enc = encodePath(path);
    const url = `${backend}/estorage/${encodeURIComponent(dbName)}/${enc}`;
    const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        signal: opts?.signal,
        headers: {
            Accept: "application/json",
        },
    });
    ensureOk(res, "listDBDir");
    return (await res.json()) as DirEntry[];
}

/**
 * Fetch a file as bytes from GET /estorage/{dbName}/{path}
 */
export async function fetchDBFileBytes(
    dbName: string,
    path: string,
    opts?: { signal?: AbortSignal }
): Promise<Uint8Array> {
    const enc = encodePath(path);
    const url = `${backend}/estorage/${encodeURIComponent(dbName)}/${enc}`;
    const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        signal: opts?.signal,
    });
    ensureOk(res, "fetchDBFileBytes");

    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
}