#!/bin/bash
# Wrapper script to run astro dev in foreground mode for Netlify Dev
# This works around Astro 7's daemon mode by tailing the log to keep process alive

cd "$(dirname "$0")/.."

# Start Astro (it will daemonize)
npx astro dev

# Wait for dev.json to be created
for i in {1..30}; do
  if [ -f .astro/dev.json ]; then
    break
  fi
  sleep 0.5
done

# Tail the log file to keep this script running
exec tail -f .astro/dev.log
