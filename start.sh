#!/usr/bin/env bash
# Runs the watcher in the background, in a tmux session called "duo" that restarts it if it ever stops.
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$DIR/.env" ]; then echo "Not set up yet. Run this first and answer the questions:  node watch.mjs"; exit 1; fi
if ! command -v tmux >/dev/null; then echo "This needs tmux (Mac: brew install tmux). Or just leave  node watch.mjs  running in a window."; exit 1; fi
if tmux has-session -t duo 2>/dev/null; then echo "Already running. See it: tmux attach -t duo"; exit 0; fi
tmux new-session -d -s duo -e "PATH=$PATH" "\"$DIR/run.sh\""
echo "Running in the background. See it: tmux attach -t duo (then Ctrl+B, D to leave it running). Stop it: tmux kill-session -t duo"
