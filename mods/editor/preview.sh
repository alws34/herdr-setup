#!/bin/sh
# A picture for the editor's image view. image() draws only files under the app folder, so the
# picture is copied into <dir>, named by its path and mtime: a changed file gets a new name (the
# new picture shows) and the old copy goes. Kinds GPUI can't decode (HEIC, TIFF, PSD…) are
# converted to PNG with macOS's sips. Prints "name width height" (0 0 when sips can't tell, SVG).
# usage: preview.sh <file> <dir>     exit 3: no such file, 4: can't convert
src=$1; dir=$2
[ -f "$src" ] || exit 3
mkdir -p "$dir"
h=$(md5 -q -s "$src" 2>/dev/null || printf %s "$src" | md5sum | cut -c1-32)
m=$(stat -f %m "$src" 2>/dev/null || stat -c %Y "$src")
ext=$(printf %s "${src##*.}" | tr 'A-Z' 'a-z')
case $ext in png|jpg|jpeg|gif|webp|bmp|svg|ico) out=$ext ;; *) out=png ;; esac
d="$dir/$h-$m.$out"
if [ ! -e "$d" ]; then
  rm -f "$dir/$h-"*
  if [ "$out" = "$ext" ]; then cp "$src" "$d" || exit 4
  else sips -s format png "$src" --out "$d" >/dev/null 2>&1 || { rm -f "$d"; exit 4; }; fi
fi
set -- $(sips -g pixelWidth -g pixelHeight "$d" 2>/dev/null | awk '/pixel(Width|Height)/ {print $2}')
echo "${d##*/} ${1:-0} ${2:-0}"
