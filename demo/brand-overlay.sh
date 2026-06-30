#!/usr/bin/env bash
# demo/brand-overlay.sh — bake the Shipwright logo lockup onto an assembled demo video.
#
# The demo-recorder title-card recorder renders flat text on a solid background and
# has no logo support, so branding is applied here as a single, repeatable ffmpeg
# pass over the assembled .mp4. The lockup (mark + wordmark + brand-green rule) is
# static for the whole video.
#
# Run AFTER assemble.sh:
#   bash demo/brand-overlay.sh demo/output/inside-a-task.mp4
# Produces demo/output/inside-a-task.mp4 in place (via a temp file).
#
# Brand values come from brand/tokens.json: base #080E1E, brand green #34C77B.
set -euo pipefail

IN="${1:-demo/output/inside-a-task.mp4}"
MARK="${MARK:-demo/assets/shipwright-mark.png}"
WORDMARK="${WORDMARK:-SHIPWRIGHT HARNESS}"
FONT="${WORDMARK_FONT:-/System/Library/Fonts/Menlo.ttc}"
GREEN="${BRAND_GREEN:-#34C77B}"

[ -f "$IN" ]   || { echo "brand-overlay: input not found: $IN" >&2; exit 1; }
[ -f "$MARK" ] || { echo "brand-overlay: mark not found: $MARK" >&2; exit 1; }

# Layout (1920x1080 canvas), top-left lockup with a 72px safe margin.
MARGIN=72
MARK_H=72                       # rendered mark height (square)
GAP=22                          # gap between mark and wordmark
WM_X=$(( MARGIN + MARK_H + GAP ))
WM_SIZE=30
WM_Y=$(( MARGIN + (MARK_H - WM_SIZE) / 2 ))   # vertically center wordmark to mark
RULE_Y=$(( MARGIN + MARK_H + 18 ))            # brand-green rule below the lockup
RULE_W=430
RULE_H=3

TMP="${IN%.mp4}.branded.tmp.mp4"

# overlay: place the scaled mark; drawtext: wordmark; drawbox: brand-green rule.
ffmpeg -y -loglevel error \
  -i "$IN" -i "$MARK" \
  -filter_complex "
    [1:v]scale=${MARK_H}:${MARK_H}[mark];
    [0:v][mark]overlay=${MARGIN}:${MARGIN}[v1];
    [v1]drawtext=fontfile='${FONT}':text='${WORDMARK}':fontcolor=white:fontsize=${WM_SIZE}:x=${WM_X}:y=${WM_Y}[v2];
    [v2]drawbox=x=${MARGIN}:y=${RULE_Y}:w=${RULE_W}:h=${RULE_H}:color=${GREEN}@0.95:t=fill[vout]
  " \
  -map "[vout]" -map 0:a? -c:a copy -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$TMP"

mv "$TMP" "$IN"
echo "brand-overlay: lockup baked into $IN"
