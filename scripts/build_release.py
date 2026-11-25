#!/usr/bin/env python3
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
DIST_DIR = ROOT / "dist"
DIST_FIREFOX_DIR = ROOT / "dist-firefox"
RELEASE_DIR = ROOT / "release"
MANIFEST_PATH = EXTENSION_DIR / "manifest.json"
BUILD_AMO_PATH = ROOT / "BUILD_AMO.md"
PACKAGE_NAME = "BiliScript"
FIREFOX_GECKO_ID = "biliscript@edmund724.github.io"

MAX_CHROMIUM_ZIP_BYTES = 1_200_000
MAX_FIREFOX_ZIP_BYTES = 1_200_000

SOURCE_INCLUDED_ROOT_FILES = {
    "BUILD_AMO.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
}
SOURCE_INCLUDED_DIRS = ("extension",)
SOURCE_INCLUDED_FILES = {
    "scripts/b2-shared-closure.js",
    "scripts/build.js",
    "scripts/build-content.js",
    "scripts/build-guards.js",
    "scripts/firefox-manifest.js",
    "scripts/vendor-mermaid-slim.mjs",
    "scripts/vendor-marked-stub.mjs",
    "scripts/vendor-d3-slim.mjs",
    "scripts/vendor-iconify-stub.mjs",
    "scripts/vendor-lodash-root-stub.mjs",
}
SOURCE_EXCLUDED_PREFIXES = ("extension/entry/chunks/",)
SOURCE_EXCLUDED_FILES = {
    "extension/entry/content-resident.iife.js",
    "extension/entry/content-resident.iife.js.map",
}

def load_manifest():
    with MANIFEST_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)

def load_package_version():
    with (ROOT / "package.json").open("r", encoding="utf-8") as fh:
        return json.load(fh).get("version") or ""

def run_build(target: str):
    cmd = ["node", str(ROOT / "scripts" / "build.js")]
    if target == "firefox":
        cmd.append("--target=firefox")
    elif target != "chromium":
        raise SystemExit(f"Unsupported build target: {target!r}")
    subprocess.run(cmd, cwd=ROOT, check=True)

def validate_dist_manifest(dist_dir: Path, expected_version: str, target: str) -> dict:
    manifest_path = dist_dir / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"{dist_dir.name}/manifest.json is missing; build failed?")

    with manifest_path.open("r", encoding="utf-8") as fh:
        dist_manifest = json.load(fh)

    actual_version = str(dist_manifest.get("version") or "").strip()
    if actual_version != expected_version:
        raise SystemExit(
            f"Version mismatch: {dist_dir.name}/manifest.json has \"version\": "
            f"{dist_manifest.get('version')!r}, expected {expected_version!r}"
        )

    if target == "firefox":
        if "minimum_chrome_version" in dist_manifest:
            raise SystemExit("dist-firefox/manifest.json must not contain minimum_chrome_version")
        permissions = set(dist_manifest.get("permissions") or [])
        for forbidden_perm in ("offscreen", "tts"):
            if forbidden_perm in permissions:
                raise SystemExit(f"dist-firefox/manifest.json must not request {forbidden_perm!r}")
        bg = dist_manifest.get("background") or {}
        if "service_worker" in bg or not isinstance(bg.get("scripts"), list) or not bg["scripts"]:
            raise SystemExit("dist-firefox/manifest.json must declare background.scripts without service_worker")
        gecko = (dist_manifest.get("browser_specific_settings") or {}).get("gecko") or {}
        if gecko.get("id") != FIREFOX_GECKO_ID:
            raise SystemExit(f"dist-firefox/manifest.json gecko.id mismatch: {gecko.get('id')!r}")
        if not gecko.get("strict_min_version"):
            raise SystemExit("dist-firefox/manifest.json missing gecko.strict_min_version")
        required_dc = (gecko.get("data_collection_permissions") or {}).get("required") or []
        if not required_dc:
            raise SystemExit("dist-firefox/manifest.json missing gecko.data_collection_permissions.required")

    return dist_manifest

def build_dist_zip(dist_dir: Path, zip_name: str, expected_version: str, target: str) -> Path:
    validate_dist_manifest(dist_dir, expected_version, target)

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = RELEASE_DIR / zip_name
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(dist_dir.rglob("*")):
            if file_path.is_dir() or file_path.suffix == ".map":
                continue
            archive.write(file_path, file_path.relative_to(dist_dir).as_posix())

    with zipfile.ZipFile(zip_path, "r") as archive:
        names = archive.namelist()
        if "manifest.json" not in names:
            raise SystemExit(f"{zip_path.name} is missing manifest.json at archive root")
        if any(name.endswith(".map") for name in names):
            raise SystemExit(f"{zip_path.name} unexpectedly contains .map files")

    return zip_path

def is_included_source_path(rel_posix: str) -> bool:
    if any(rel_posix.startswith(prefix) for prefix in SOURCE_EXCLUDED_PREFIXES):
        return False
    if rel_posix in SOURCE_EXCLUDED_FILES:
        return False
    if rel_posix in SOURCE_INCLUDED_ROOT_FILES or rel_posix in SOURCE_INCLUDED_FILES:
        return True
    parts = rel_posix.split("/")
    return len(parts) > 1 and parts[0] in SOURCE_INCLUDED_DIRS

def collect_source_files() -> list[str]:
    if not BUILD_AMO_PATH.is_file():
        raise SystemExit("BUILD_AMO.md is missing; required for AMO source archive")

    proc = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    tracked = [
        item
        for item in proc.stdout.decode("utf-8", errors="strict").split("\0")
        if item
    ]

    rel_paths = set(tracked)
    rel_paths.add("BUILD_AMO.md")

    filtered: list[str] = []
    for rel_posix in sorted(rel_paths):
        if not is_included_source_path(rel_posix):
            continue
        full_path = ROOT / rel_posix
        if full_path.is_file():
            filtered.append(rel_posix)

    return filtered

def build_source_zip(version: str) -> tuple[Path, int]:
    source_files = collect_source_files()
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-Source.zip"
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for rel_posix in source_files:
            archive.write(ROOT / rel_posix, rel_posix)

    required_files = SOURCE_INCLUDED_ROOT_FILES | SOURCE_INCLUDED_FILES | {"extension/manifest.json"}
    with zipfile.ZipFile(zip_path, "r") as archive:
        names = set(archive.namelist())
        for required in sorted(required_files):
            if required not in names:
                raise SystemExit(f"{zip_path.name} is missing required source file: {required}")
        for name in names:
            if not is_included_source_path(name):
                raise SystemExit(f"{zip_path.name} unexpectedly includes non-build path: {name}")

    return zip_path, len(source_files)

def assert_zip_budget(zip_path: Path, max_bytes: int, label: str):
    zip_size = zip_path.stat().st_size
    if zip_size > max_bytes:
        raise SystemExit(
            f"{label} ZIP size guard failed: {zip_size} bytes exceeds budget {max_bytes} bytes"
        )

def main():
    manifest = load_manifest()
    version = str(manifest.get("version") or "").strip()
    if not version:
        raise SystemExit("manifest.json is missing a version")

    package_version = load_package_version().strip()
    if package_version != version:
        raise SystemExit(
            f"Version mismatch: manifest.json has \"version\": {version}, "
            f"but package.json has \"version\": {package_version!r}"
        )

    print("Building dist/ (Chromium target) ...", flush=True)
    run_build("chromium")
    chromium_zip = build_dist_zip(
        DIST_DIR,
        f"{PACKAGE_NAME}-v{version}-Chromium.zip",
        version,
        "chromium",
    )
    assert_zip_budget(chromium_zip, MAX_CHROMIUM_ZIP_BYTES, "Chromium")

    print("Building dist-firefox/ (Firefox target) ...", flush=True)
    run_build("firefox")
    firefox_zip = build_dist_zip(
        DIST_FIREFOX_DIR,
        f"{PACKAGE_NAME}-v{version}-Firefox.zip",
        version,
        "firefox",
    )
    assert_zip_budget(firefox_zip, MAX_FIREFOX_ZIP_BYTES, "Firefox")

    print("Building AMO Source archive ...", flush=True)
    source_zip, source_count = build_source_zip(version)

    print(f"Built release packages for v{version}:")
    print(f"- Chromium: {chromium_zip} ({chromium_zip.stat().st_size} bytes)")
    print(f"- Firefox:  {firefox_zip} ({firefox_zip.stat().st_size} bytes)")
    print(f"- Source:   {source_zip} ({source_zip.stat().st_size} bytes, {source_count} files)")

if __name__ == "__main__":
    main()
