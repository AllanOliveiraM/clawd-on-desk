#!/bin/sh
# Installs the Clawd Pointer Bridge GNOME Shell extension for the current user.
# GNOME on Wayland only finds a new extension in a new session: log out and in.
set -eu
uuid="clawd-pointer@clawd-on-desk"
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/extensions/gnome-shell/$uuid"
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
mkdir -p "$target_dir"
cp "$source_dir/metadata.json" "$source_dir/extension.js" "$source_dir/pointerServer.js" "$target_dir/"
current="$(gsettings get org.gnome.shell enabled-extensions)"
case "$current" in
  *"$uuid"*) ;;
  "@as []") gsettings set org.gnome.shell enabled-extensions "['$uuid']" ;;
  *) gsettings set org.gnome.shell enabled-extensions "${current%]}, '$uuid']" ;;
esac
echo "Installed $uuid. Log out and back in to load it."
