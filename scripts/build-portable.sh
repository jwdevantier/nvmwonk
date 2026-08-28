#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025 Jesper Wendel Devantier <jwd@defmacro.it>
#
# SPDX-License-Identifier: BSD-2-Clause
#
# Build a portable single-file executable of nvmwonk.py — the same as
# scripts/build.sh, plus a patchelf step that detaches the binary from
# the build host's Nix store so it runs on a stock (non-Nix) Linux.
#
# Use case: you're on NixOS or running in a Nix shell, and want to ship
# the binary to a colleague on Ubuntu / Fedora / etc.
#
# This script only does anything useful when run on a Nix system. On a
# non-Nix host, scripts/build.sh already produces a portable binary —
# this script will refuse to run.

set -euo pipefail

# Nix detection first, so we can bail out cleanly on non-Nix hosts
# without depending on anything beyond POSIX shell builtins.
#
# Two independent signals, either is enough:
#   1. $NIX_STORE is set — typical inside `nix develop` or any
#      nix-daemon-spawned shell. Honours custom store locations
#      (e.g. /nix/store on most installs, /var/nix/store elsewhere).
#   2. `nix` is on PATH — typical on NixOS and on any system where
#      a Nix profile is sourced, regardless of $NIX_STORE.
on_nix=0
if [ -n "${NIX_STORE:-}" ] || command -v nix >/dev/null 2>&1; then
  on_nix=1
fi

if [ "$on_nix" = 0 ]; then
  echo "Not running on a Nix system. scripts/build.sh already produces a" >&2
  echo "portable binary as-is on this host; this script has nothing to add." >&2
  echo "" >&2
  echo "(If Nix detection failed unexpectedly, set NIX_STORE or put 'nix'" >&2
  echo "on PATH and try again.)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-nvmwonk}"

# 1. Run the plain PyInstaller build.
scripts/build.sh "$@"

# 2. Rewrite the ELF interpreter to a portable system path. PyInstaller's
#    binary has interpreter=/nix/store/.../ld-linux-x86-64.so.2 on a
#    Nix build host; /lib64/ld-linux-x86-64.so.2 is the canonical path
#    on every major Linux distro and is what the kernel execs natively.
#
#    We don't try to bundle libz — every distro ships it (libz.so.1 is
#    in base glibc/zlib packages), so DT_NEEDED resolves on the target.
echo ""
echo "==> Patching interpreter to /lib64/ld-linux-x86-64.so.2"
patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 "dist/$APP_NAME"

echo ""
echo "==> Done. Ship dist/$APP_NAME to your non-Nix target."
echo "    Target needs glibc ≥ 2.31 and libz.so.1 (universal across distros)."