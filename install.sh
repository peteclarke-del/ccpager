#!/usr/bin/env bash
# One-step Linux install: puts `ccpager` on your PATH, adds the settings window to
# your app menu, and opens it. Nothing is routed through ccpager until you switch
# it on in the window (Setup → "All Claude Code apps") or run `ccpager vscode`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "✗ Node.js 18+ is required (https://nodejs.org)."; exit 1; fi
if ! "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  echo "✗ Node.js 18+ is required; you have $("$NODE" -v)."; exit 1
fi

mkdir -p "$HOME/.local/bin"
chmod +x "$DIR/bin/ccpager.js"
ln -sf "$DIR/bin/ccpager.js" "$HOME/.local/bin/ccpager"
echo "✓ ccpager command installed ($HOME/.local/bin/ccpager)"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  Note: add ~/.local/bin to your PATH to use it from a terminal.";; esac

if "$NODE" "$DIR/bin/ccpager.js" gui --install >/dev/null 2>&1; then  # finds a Python that can load GTK 4
  echo "✓ Added \"ccpager\" to your app menu"
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    "$NODE" "$DIR/bin/ccpager.js" gui
    echo "✓ Settings window opened. Next time, find \"ccpager\" in your app menu."
  fi
else
  echo "! The settings window needs GTK 4 + libadwaita for Python. Install them, then run: ccpager gui --install"
  if command -v apt >/dev/null; then echo "    sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1"
  elif command -v dnf >/dev/null; then echo "    sudo dnf install python3-gobject gtk4 libadwaita"
  elif command -v pacman >/dev/null; then echo "    sudo pacman -S python-gobject gtk4 libadwaita"
  elif command -v zypper >/dev/null; then echo "    sudo zypper install python3-gobject typelib-1_0-Gtk-4_0 typelib-1_0-Adw-1"
  fi
  echo "  The command line works without it: ccpager vscode"
fi
