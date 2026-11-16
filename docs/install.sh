#!/bin/sh
# Installs Festoon for the current user. No root needed.
#
#   curl -fsSL https://dabane-ghassan.github.io/festoon/install.sh | sh
#
# Works on any distro with the GNOME desktop: it only uses sh, curl and tar.
#   sh install.sh             install from this folder instead (a checkout or an unpacked release)
#   sh install.sh --remove    uninstall (what hangs on the line is kept in ~/.local/share/festoon)
set -eu

UUID="festoon@dabane-ghassan.github.io"
APP="io.github.dabane_ghassan.Festoon"
RELEASE="https://github.com/dabane-ghassan/festoon/releases/latest/download/festoon.tar.gz"
SOURCE="https://github.com/dabane-ghassan/festoon/archive/refs/heads/main.tar.gz"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT="$DATA/gnome-shell/extensions/$UUID"
BIN="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }

if [ "${1:-}" = "--remove" ]; then
    gdbus call --session --dest io.github.dabane_ghassan.Festoon.Line --object-path /io/github/dabane_ghassan/Festoon/Line \
        --method io.github.dabane_ghassan.Festoon.Line.Quit >/dev/null 2>&1 || true
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    rm -rf "$EXT" "$BIN/festoon" "$DATA/applications/$APP.desktop" \
        "$DATA/icons/hicolor/scalable/apps/$APP.svg"
    say "Festoon removed. Your settings and $DATA/festoon are kept; log out and back in to finish."
    exit 0
fi

command -v gnome-shell >/dev/null 2>&1 || { say "Festoon needs the GNOME desktop (GNOME Shell 45 or later)."; exit 1; }
command -v gjs >/dev/null 2>&1 || { say "Festoon needs 'gjs' (it comes with GNOME; install the gjs package)."; exit 1; }

# Find the files: next to this script, or download the latest release.
SRC=""
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/extension/metadata.json" ]; then
    SRC="$HERE"
else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    say "Downloading Festoon..."
    fetch() {
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$1" -o "$2" 2>/dev/null
        else
            wget -q "$1" -O "$2"
        fi
    }
    # the latest release, or the current source when there is no release yet
    if fetch "$RELEASE" "$TMP/festoon.tar.gz"; then
        tar -xzf "$TMP/festoon.tar.gz" -C "$TMP"
    elif fetch "$SOURCE" "$TMP/source.tar.gz"; then
        tar -xzf "$TMP/source.tar.gz" -C "$TMP"
        mv "$TMP/festoon-main" "$TMP/festoon"
    else
        say "Could not download Festoon. Check your connection and try again."
        exit 1
    fi
    SRC="$TMP/festoon"
fi

WAS=""
[ -f "$EXT/metadata.json" ] && WAS="$(sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' "$EXT/metadata.json")"
NOW="$(sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' "$SRC/extension/metadata.json")"
mkdir -p "$BIN" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps"
rm -rf "$EXT"
mkdir -p "$EXT"
cp -R "$SRC/extension/." "$EXT/"
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$EXT/schemas"
fi
install -m 755 "$SRC/bin/festoon" "$BIN/festoon"
sed "s|^Exec=festoon|Exec=$BIN/festoon|" "$SRC/packaging/$APP.desktop" > "$DATA/applications/$APP.desktop"
cp "$SRC/extension/assets/icons/festoon.svg" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
gtk-update-icon-cache -q "$DATA/icons/hicolor" >/dev/null 2>&1 || true

gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

say ""
if [ -n "$WAS" ] && [ "$WAS" != "$NOW" ]; then
    say "Festoon updated from $WAS to $NOW."
elif [ -n "$WAS" ]; then
    say "Festoon $NOW reinstalled."
else
    say "Festoon $NOW is installed."
fi
if gdbus call --session --dest org.gnome.Shell --object-path /io/github/dabane_ghassan/Festoon \
        --method io.github.dabane_ghassan.Festoon.GetState >/dev/null 2>&1; then
    say "Log out and back in to load the new version."
else
    say "Log out and back in once so GNOME loads it."
fi
say "Then rest the pointer on the top bar, click the clothespin there, or press Ctrl+Alt+J."
if ! command -v tesseract >/dev/null 2>&1; then
    say "(Optional: install tesseract so search can find the text in your screenshots.)"
fi
case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "(The 'festoon' command is in $BIN, which is not on your PATH yet.)" ;;
esac
