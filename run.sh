#!/usr/bin/env bash
# Keeps watch.mjs running forever: restarts it 10 s after any exit. Logs to watch.log.
cd "$(dirname "$0")"
while true; do
	"${NODE:-node}" watch.mjs 2>&1 | tee -a watch.log
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) watcher exited (${PIPESTATUS[0]}), restarting in 10s" | tee -a watch.log
	sleep 10
done
