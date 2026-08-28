#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025 Jesper Wendel Devantier <jwd@defmacro.it>
#
# SPDX-License-Identifier: BSD-2-Clause
#
# Build a single-file executable of nvmwonk.py with PyInstaller.
#
# Produces dist/nvmwonk — a binary that runs on this build host.
#
# To produce a binary portable to non-Nix Linux (when this host is on
# Nix), use scripts/build-portable.sh instead.

set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-nvmwonk}"
ENTRY="${ENTRY:-nvmwonk.py}"

echo "==> Cleaning previous build artifacts"
rm -rf build dist "${APP_NAME}.spec"

echo "==> Running PyInstaller"
pyinstaller \
  --onefile \
  --collect-all lxml \
  --collect-all docx \
  --name "$APP_NAME" \
  "$ENTRY"

[ -f "dist/$APP_NAME" ] || { echo "error: dist/$APP_NAME not produced"; exit 1; }

echo ""
echo "==> Done: dist/$APP_NAME"