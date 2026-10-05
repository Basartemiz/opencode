#!/usr/bin/env bash
# Stitches the silent demo: title card, terminal recording (if present), title card, map recording.
# Usage: make_demo.sh <media dir>   (expects map.webm, optional ../session/terminal.mp4 or terminal.mov)
# SESSION_DIR=<dir> picks another session folder; INTRO="<text>" changes the first card's subtitle (no colons: ffmpeg drawtext treats them as separators).
set -euo pipefail
MEDIA="$(cd "${1:?media dir}" && pwd)"
SESSION="$(cd "${SESSION_DIR:-$MEDIA/../session}" && pwd)"
FONT="${FONT:-$(fc-match -f '%{file}' 'Inter:bold' 2>/dev/null || true)}"
W=1440
H=900
TERMINAL_SPEED="${TERMINAL_SPEED:-4}"
MAP_SPEED="${MAP_SPEED:-1.25}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

card() { # card <out> <title> <subtitle> <seconds>
  ffmpeg -v error -y -f lavfi -i "color=c=0x151513:s=${W}x${H}:r=30:d=$4" \
    -vf "drawtext=fontfile='$FONT':text='$2':fontcolor=0xedece7:fontsize=54:x=(w-text_w)/2:y=(h/2)-60,\
drawtext=fontfile='$FONT':text='$3':fontcolor=0xa3a199:fontsize=28:x=(w-text_w)/2:y=(h/2)+20" \
    -c:v libx264 -pix_fmt yuv420p "$1"
}

fit() { # fit <in> <out> <speed>: speed up, scale into WxH, pad, 30 fps, no audio
  ffmpeg -v error -y -i "$1" -an \
    -vf "setpts=PTS/${3:-1},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x151513,fps=30,format=yuv420p" \
    -c:v libx264 -crf 20 "$2"
}

parts=()
card "$TMP/0.mp4" "/understand mode for OpenCode" "${INTRO:-The agent pauses after each feature so you can see what it changed}" 4
parts+=("$TMP/0.mp4")

TERMINAL=""
for candidate in "$SESSION/terminal.mp4" "$SESSION/terminal.mov"; do
  [ -f "$candidate" ] && TERMINAL="$candidate" && break
done
if [ -n "$TERMINAL" ]; then
  card "$TMP/1.mp4" "1. In the terminal" "Real run, shown at ${TERMINAL_SPEED}x speed. Approve or ask for a revision at each checkpoint" 4
  fit "$TERMINAL" "$TMP/2.mp4" "$TERMINAL_SPEED"
  parts+=("$TMP/1.mp4" "$TMP/2.mp4")
else
  echo "no terminal recording found; the demo shows the map only" >&2
fi

card "$TMP/3.mp4" "2. On the map" "Each checkpoint explained, checked against the real code" 3
fit "$MEDIA/map.webm" "$TMP/4.mp4" "$MAP_SPEED"
parts+=("$TMP/3.mp4" "$TMP/4.mp4")

: > "$TMP/list.txt"
for part in "${parts[@]}"; do echo "file '$part'" >> "$TMP/list.txt"; done
ffmpeg -v error -y -f concat -safe 0 -i "$TMP/list.txt" -c copy -movflags +faststart "$MEDIA/demo.mp4"
echo "wrote $MEDIA/demo.mp4 ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MEDIA/demo.mp4" | cut -d. -f1) s, no audio)"
