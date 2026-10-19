#!/bin/sh
# Updates the sync server to GitHub's master and restarts it; rolls back if
# the new version does not answer /health. Installed as root-owned
# /usr/local/sbin/listik-deploy (a copy: a pull never changes it) and run by
# GitHub Actions (.github/workflows/server.yml) as the user listik-deploy,
# whose SSH key can run this and nothing else (server/DEPLOY.md, step 9).
set -eu
SRC=/opt/listik/src
APP=/opt/listik
HEALTH=http://127.0.0.1:8787/health

# One deploy at a time.
exec 9>/run/listik-deploy.lock
flock 9

git -C "$SRC" fetch --quiet origin master
git -C "$SRC" reset --quiet --hard origin/master
rev=$(git -C "$SRC" rev-parse --short HEAD)
node --check "$SRC/server/index.js"

if cmp -s "$SRC/server/index.js" "$APP/index.js"; then
  echo "listik-deploy: $rev, server code unchanged"
  exit 0
fi

healthy() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    curl -fsS -m 2 "$HEALTH" >/dev/null 2>&1 && return 0
  done
  return 1
}

cp -p "$APP/index.js" "$APP/index.js.prev"
install -m 644 "$SRC/server/index.js" "$APP/index.js"
install -m 644 "$SRC/server/package.json" "$APP/package.json"
systemctl restart listik-sync
if healthy; then
  echo "listik-deploy: $rev deployed"
else
  echo "listik-deploy: $rev did not come up, rolling back" >&2
  cp -p "$APP/index.js.prev" "$APP/index.js"
  systemctl restart listik-sync
  healthy && echo "listik-deploy: previous version restored" >&2
  exit 1
fi
