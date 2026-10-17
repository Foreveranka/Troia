#!/usr/bin/env bash
set -euo pipefail
cd /opt/troia/current
# A kernel lock survives in fd 9 for the full Node lifetime and is released even after SIGKILL/power loss.
exec 9>/var/lib/troia/service.lock
/usr/bin/flock --nonblock 9 || { echo 'Another Troia service writer is running' >&2; exit 75; }
export TROIA_SERVICE_LOCK_HELD=1
pool="$(/usr/bin/node --input-type=module -e 'import fs from "node:fs"; const d=JSON.parse(fs.readFileSync(process.env.TROIA_DEPLOYMENT_PATH,"utf8")); if(!/^C[A-Z2-7]{55}$/.test(d.troyPool)) throw Error("Invalid pool"); process.stdout.write(d.troyPool)')"
/usr/bin/node scripts/recover-writer-lock.mjs "${TROIA_DATA_DIR}/${pool}"
exec /usr/bin/node dist/main.js
