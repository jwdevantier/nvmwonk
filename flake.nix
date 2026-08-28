# SPDX-FileCopyrightText: 2025 Jesper Wendel Devantier <jwd@defmacro.it>
#
# SPDX-License-Identifier: BSD-2-Clause
{
  description = "TP4176 NVMe Rate Limiting — parse .docx into structured XML for LLM consumption";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      allSystems = [
        "x86_64-linux"
        "x86_64-darwin"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forAllSystems = fn:
        nixpkgs.lib.genAttrs allSystems
          (system: fn {
            pkgs = import nixpkgs { inherit system; };
            inherit system;
          });
    in
    {
      devShells = forAllSystems ({ pkgs, system, ... }: {
        default = pkgs.mkShell {
          name = "tp4176-parse";

          packages = with pkgs; [
            # Python + docx parsing
            (python3.withPackages (ps: with ps; [
              python-docx
              lxml
            ]))
            # XML tooling
            libxml2
            # Other utilities
            pandoc
          ];

          shellHook = ''
            echo "🔧 tp4176-parse dev shell"
            echo "   python3 with python-docx + lxml available"
            echo "   pandoc $(pandoc --version | head -1)"
            echo ""
            echo "   Try:  python3 nvmwonk.py extract tp4176.docx tp4176.xml"
          '';
        };

        # Dev shell for building self-contained executables with PyInstaller.
        # PyInstaller bundles the entire CPython runtime + stdlib + transitive
        # .so deps (including lxml's libxml2/libxslt/libexslt via its lxml
        # hook) into one ELF; the build script then patches the interpreter
        # and zlib references that the Nix build environment embeds.
        #
        # Pinned to Python 3.13 because current nixpkgs `python3` is 3.14,
        # which PyInstaller 6.x does not yet fully support. Bump back to
        # `python3` once nixpkgs carries a PyInstaller release that supports
        # 3.14.
        #
        # Usage:
        #   nix develop .#bundler
        #   scripts/build.sh --keep-nix
        bundler = pkgs.mkShell {
          name = "tp4176-parse-bundler";

          packages = with pkgs; [
            # Python 3.13 + project deps + PyInstaller (with its runtime deps)
            (python313.withPackages (ps: with ps; [
              python-docx
              lxml
              pyinstaller
            ]))

            # patchelf — used by scripts/build.sh to rewrite the interpreter
            # path and bundle libz into the produced ELF
            patchelf

            # lxml's .so files dynamically link against these; having them on
            # PATH lets PyInstaller's lxml hook discover and bundle them
            libxml2
            libxslt

            # Misc utilities
            file
            pandoc
          ];

          shellHook = ''
            echo "📦 tp4176-parse — bundler shell (Python 3.13)"
            echo "   patchelf:    $(patchelf --version)"
            echo "   pyinstaller: $(pyinstaller --version 2>&1 || true)"
            echo "   python:      $(python3 --version)"
            echo ""
            echo "   Build for this host:        scripts/build.sh"
            echo "   Build for non-Nix targets:  scripts/build-portable.sh"
            echo "   Output:                     ./dist/nvmwonk"
            echo ""
            echo "   CLI: nvmwonk.py {extract | query {figures|figure|section|xpath}} --help"
          '';
        };
      });
    };
}