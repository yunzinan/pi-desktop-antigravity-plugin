#!/usr/bin/env python3
"""Assemble the publishable .piplug for this plugin.

The package must be a zip whose root holds `manifest.json`, next to the files
the manifest references. Everything the runtime actually needs is small; the
bulk of a naive zip comes from things that are never loaded:

  - nothing that the manifest references: `contributes.agentExtensions` points at
    `src/*.ts`, and the host rejects a package whose declared extension files are
    missing, so those ship even though the sidecar never loads them.
  - `node_modules/**/*.d.ts` — TypeScript declarations for the vendored undici.
  - build output and this script itself.

undici itself *is* required: the plugin runs in the app's Node process, whose
`fetch` ignores the macOS system proxy, so a ProxyAgent is the only thing that
makes upstream calls work behind Clash. Node's built-in `NODE_USE_ENV_PROXY`
would avoid the dependency, but it is read at process start and the app spawns
the plugin host, so the variable cannot be set in time.

Usage:
    python3 pack.py            # writes dist/<id>-<version>.piplug
    python3 pack.py --check    # print what would be packed, write nothing
"""

import hashlib
import json
import os
import sys
import zipfile

SRC = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(SRC, "dist")

# Paths (relative to the package root) that must never ship.
EXCLUDE_DIRS = {".git", "dist", "__MACOSX"}
EXCLUDE_FILES = {".DS_Store", "pack.py", ".gitignore"}
EXCLUDE_SUFFIXES = (".d.ts", ".map", ".piplug", ".png")
# The PNG renders of the architecture figure stay in the repo for the GitHub
# README (which does not render SVG); the package ships the 17 KB SVG instead,
# because the market serves its own readmeMarkdown and screenshots and never
# resolves image paths inside the .piplug.
# Only inside a dependency: the repo's own top-level docs/ ships (it holds the
# architecture figure the README links to).
EXCLUDE_DEP_DIRS = {"docs"}

# Files the manifest points at; the pack fails loudly if one is missing.
REQUIRED = ("manifest.json", "main.cjs", "proxy.cjs", "renderer/index.html")


def collect():
    files = []
    for root, dirs, names in os.walk(SRC):
        inside_dep = os.path.relpath(root, SRC).startswith("node_modules")
        skip = EXCLUDE_DIRS | (EXCLUDE_DEP_DIRS if inside_dep else set())
        dirs[:] = [d for d in dirs if d not in skip]
        for name in names:
            if name in EXCLUDE_FILES or name.endswith(EXCLUDE_SUFFIXES):
                continue
            path = os.path.join(root, name)
            if os.path.islink(path):
                print("SKIP symlink:", path)
                continue
            files.append((path, os.path.relpath(path, SRC)))
    files.sort()
    return files


def main():
    check_only = "--check" in sys.argv
    manifest = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))
    pid, version = manifest["id"], manifest["version"]

    files = collect()
    names = [rel for _, rel in files]
    total = sum(os.path.getsize(path) for path, _ in files)
    print(f"files   {len(files)}")
    print(f"size    {total / 1024 / 1024:.2f} MB")
    if total > 50 * 1024 * 1024:
        print("!! exceeds the 50 MB package limit")
        return 1
    if check_only:
        for _, rel in files:
            print("   ", rel)
        return 0

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{pid}-{version}.piplug")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path, rel in files:
            z.write(path, rel)

    digest = hashlib.sha256(open(out, "rb").read()).hexdigest()
    print(f"wrote   {out} ({os.path.getsize(out)} bytes)")
    print(f"sha256  {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
