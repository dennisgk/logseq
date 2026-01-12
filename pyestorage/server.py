# server.py
from __future__ import annotations

import hashlib
import os
import shutil
import zipfile
from pathlib import Path
from typing import List, Literal, TypedDict
from urllib.parse import unquote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles


# -----------------------------
# Paths (relative to this file)
# -----------------------------
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
FILES_DIR = BASE_DIR / "files"
TMP_DIR = BASE_DIR / "tmp"

STATIC_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)


# -----------------------------
# App + CORS
# -----------------------------
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://logseq.kountouris.org"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -----------------------------
# Helpers
# -----------------------------
def _safe_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(400, "DB NAME cannot be empty.")
    for ch in name:
        if not (ch.isalnum() or ch in " ._-"):
            raise HTTPException(400, f"Invalid DB NAME char: {ch!r}")
    name = name.replace("\\", "/")
    if "/" in name or name in (".", ".."):
        raise HTTPException(400, "Invalid DB NAME.")
    return name


def _safe_rel_path(p: str) -> str:
    p = unquote(p or "")
    p = p.replace("\\", "/").lstrip("/")
    return p


def _resolve_under(root: Path, rel: str) -> Path:
    rel = _safe_rel_path(rel)
    target = (root / rel).resolve()
    root_resolved = root.resolve()
    if root_resolved == target or str(target).startswith(str(root_resolved) + os.sep):
        return target
    raise HTTPException(400, "Invalid path (path traversal).")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class DirEntry(TypedDict, total=False):
    type: Literal["dir", "file"]
    name: str
    sha256: str


def list_dir_level(dir_path: Path) -> List[DirEntry]:
    out: List[DirEntry] = []
    try:
        for child in sorted(dir_path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if child.is_dir():
                out.append({"type": "dir", "name": child.name})
            elif child.is_file():
                out.append({"type": "file", "name": child.name, "sha256": sha256_file(child)})
    except FileNotFoundError:
        raise HTTPException(404, "Directory not found.")
    return out


def _zip_has_single_root_folder(names: List[str]) -> str | None:
    """
    If the zip content is entirely under one top-level folder, return that folder name (with trailing '/').
    Otherwise return None.
    """
    tops = set()
    for n in names:
        n = n.replace("\\", "/")
        if not n or n.startswith("/") or n.startswith("../") or "/../" in n:
            continue
        parts = n.split("/")
        if parts and parts[0]:
            tops.add(parts[0])
            if len(tops) > 1:
                return None
    if len(tops) == 1:
        return next(iter(tops)) + "/"
    return None


def _detect_zip_prefix_for_bundle(z: zipfile.ZipFile) -> str:
    """
    Accept either:
      - db.sqlite at zip root
      - OR db.sqlite under the first/top folder (common when zipping a folder)
    Returns prefix "" or "SomeFolder/" such that prefix + "db.sqlite" exists.
    """
    names = [n.replace("\\", "/") for n in z.namelist()]

    # Preferred: db.sqlite at root
    if "db.sqlite" in names:
        return ""

    # If not at root, try "single top-level folder" pattern
    root_folder = _zip_has_single_root_folder(names)
    if root_folder and (root_folder + "db.sqlite") in names:
        return root_folder

    # Fallback: if there exists *any* "<something>/db.sqlite", try the first path segment
    candidates = [n for n in names if n.endswith("/db.sqlite") and n.count("/") >= 1]
    if candidates:
        prefix = candidates[0].split("/", 1)[0] + "/"
        return prefix

    raise HTTPException(
        400,
        "Zip must contain 'db.sqlite' at the root OR inside the first/top folder.",
    )


def _is_safe_member_name(name: str) -> bool:
    name = name.replace("\\", "/")
    if not name or name.startswith("/") or name.startswith("../") or "/../" in name:
        return False
    return True


def _extract_zip_to_db_folder(db_folder: Path, zip_path: Path) -> None:
    """
    Extract zip bundle into db_folder. Supports zips that are either:
      - db.sqlite + assets/ at root
      - or a single root folder that contains db.sqlite + assets/
    If a root folder is detected, it is stripped during extraction so the
    contents end up directly in ./files/{DB_NAME}/.

    Also enforces zip-slip protection.
    """
    db_folder.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path, "r") as z:
        prefix = _detect_zip_prefix_for_bundle(z)  # "" or "SomeFolder/"

        for member in z.infolist():
            raw = member.filename.replace("\\", "/")

            if not _is_safe_member_name(raw):
                raise HTTPException(400, f"Unsafe zip entry: {member.filename}")

            # If we're extracting from a prefixed folder, ignore anything outside that prefix
            if prefix:
                if not raw.startswith(prefix):
                    continue
                rel_name = raw[len(prefix) :]
                if rel_name == "" or rel_name.endswith("/") and rel_name == "/":
                    continue
            else:
                rel_name = raw

            # After stripping prefix, skip empty
            rel_name = rel_name.lstrip("/")
            if not rel_name:
                continue

            dest = (db_folder / rel_name).resolve()
            db_root = db_folder.resolve()
            if not (dest == db_root or str(dest).startswith(str(db_root) + os.sep)):
                raise HTTPException(400, f"Unsafe zip entry (zip-slip): {member.filename}")

            if member.is_dir() or rel_name.endswith("/"):
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(member, "r") as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)

        # Ensure db.sqlite ended up in db_folder root after extraction
        if not (db_folder / "db.sqlite").is_file():
            raise HTTPException(
                400,
                "After extraction, 'db.sqlite' was not found at the bundle root. "
                "Your zip structure is not supported.",
            )


# -----------------------------
# Routes
# -----------------------------
@app.get("/estorage")
def list_dbs() -> List[str]:
    return sorted([p.name for p in FILES_DIR.iterdir() if p.is_dir()])


@app.post("/estorage/{db_name}")
async def upload_estorage(db_name: str, file: UploadFile = File(...)):
    db_name = _safe_name(db_name)
    db_folder = FILES_DIR / db_name

    tmp_dir = TMP_DIR
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_zip = tmp_dir / f"{db_name}.upload.zip"

    try:
        with tmp_zip.open("wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)

        if not zipfile.is_zipfile(tmp_zip):
            raise HTTPException(400, "Uploaded file is not a valid zip.")

        if db_folder.exists():
            shutil.rmtree(db_folder)
        db_folder.mkdir(parents=True, exist_ok=True)

        _extract_zip_to_db_folder(db_folder, tmp_zip)
        return {"ok": True, "db": db_name}
    finally:
        try:
            if tmp_zip.exists():
                tmp_zip.unlink()
        except Exception:
            pass


@app.get("/estorage/{db_name}/{req_path:path}")
def get_estorage_path(db_name: str, req_path: str):
    db_name = _safe_name(db_name)
    db_root = FILES_DIR / db_name
    if not db_root.exists() or not db_root.is_dir():
        raise HTTPException(404, "DB not found.")

    target = _resolve_under(db_root, req_path)

    if target.is_file():
        return FileResponse(str(target))

    if target.is_dir():
        return JSONResponse(list_dir_level(target))

    raise HTTPException(404, "Not found.")


@app.get("/estorage/{db_name}")
def get_estorage_root(db_name: str):
    db_name = _safe_name(db_name)
    db_root = FILES_DIR / db_name
    if not db_root.exists() or not db_root.is_dir():
        raise HTTPException(404, "DB not found.")
    return JSONResponse(list_dir_level(db_root))


# Serve /static at / (but note: this can shadow API routes if mounted at "/")
# Example: ./static/test.png -> GET /test.png
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=False), name="static-root")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
