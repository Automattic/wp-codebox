#!/usr/bin/env python3
"""Build the one-read PHP hydration pack from a retained Miniflare R2 revision."""

import argparse
import datetime
import hashlib
import json
import sqlite3
import uuid
import zipfile
from pathlib import Path


def one(paths: list[Path], label: str) -> Path:
    if len(paths) != 1:
        raise RuntimeError(f"Expected one {label}; found {len(paths)}.")
    return paths[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("state", type=Path)
    parser.add_argument("source_revision")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    r2 = args.state / "v3/r2"
    db = one([path for path in (r2 / "miniflare-R2BucketObject").glob("*.sqlite") if path.name != "metadata.sqlite"], "Miniflare R2 database")
    bucket = one([path for path in r2.iterdir() if path.is_dir() and path.name not in {"miniflare-R2BucketObject"}], "Miniflare R2 bucket")
    blobs = bucket / "blobs"
    connection = sqlite3.connect(db)

    def body(key: str) -> bytes:
        row = connection.execute("SELECT blob_id,size FROM _mf_objects WHERE key=?", (key,)).fetchone()
        if not row:
            raise RuntimeError(f"Missing local R2 object: {key}")
        data = (blobs / row[0]).read_bytes()
        if len(data) != row[1]:
            raise RuntimeError(f"Size mismatch: {key}")
        return data

    source_key = f"sites/default/markdown/revisions/{args.source_revision}.json"
    manifest = json.loads(body(source_key))
    markdown = manifest["files"]
    wp_content = [
        file for file in manifest.get("wpContent", [])
        if not file["path"].startswith("themes/bricks/assets/")
        and not file["path"].startswith("themes/bricks/languages/")
    ]
    entries = [(f"markdown/{file['path']}", file) for file in markdown]
    entries += [(f"wp-content/{file['path']}", file) for file in wp_content]
    entries.sort(key=lambda item: item[0])

    args.output.mkdir(parents=True, exist_ok=False)
    pack_path = args.output / "runtime-restore-pack.zip"
    decoded = 0
    with zipfile.ZipFile(pack_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, file in entries:
            data = body(file["objectKey"])
            if hashlib.sha256(data).hexdigest() != file["sha256"] or len(data) != file["size"]:
                raise RuntimeError(f"Integrity mismatch: {file['objectKey']}")
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
            decoded += len(data)
        tombstones = json.dumps({"wpContentDeleted": manifest.get("wpContentDeleted", [])}, separators=(",", ":")).encode()
        info = zipfile.ZipInfo("metadata/wp-content-deleted.json", date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, tombstones, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)

    pack = pack_path.read_bytes()
    pack_sha = hashlib.sha256(pack).hexdigest()
    revision = str(uuid.uuid4())
    persisted_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    manifest.update({
        "revision": revision,
        "manifestKey": f"sites/default/markdown/revisions/{revision}.json",
        "persistedAt": persisted_at,
        "restorePack": {
            "schema": "wp-codebox/cloudflare-canonical-restore-pack/v1",
            "objectKey": f"sites/default/restore-packs/{pack_sha}.zip",
            "sha256": pack_sha,
            "size": len(pack),
            "fileCount": len(entries),
            "decodedBytes": decoded,
        },
    })
    manifest_path = args.output / f"{revision}.json"
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")))
    pointer = {"revision": revision, "manifestKey": manifest["manifestKey"], "persistedAt": persisted_at}
    (args.output / "pointer.json").write_text(json.dumps(pointer, separators=(",", ":")))
    print(json.dumps({**pointer, "restorePack": manifest["restorePack"], "sourceRevision": args.source_revision}, indent=2))


if __name__ == "__main__":
    main()
