#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
TEMPLATE="${SCRIPT_DIR}/com.torriani.dominus-daily.plist.template"
WATCHDOG_TEMPLATE="${SCRIPT_DIR}/com.torriani.dominus-daily-watchdog.plist.template"
CONFIG="${SCRIPT_DIR}/config/control-plane.json"
USER_DOMAIN="gui/$(id -u)"
LOG_DIR="${HOME}/.paperclip/instances/eliaquim/dominus-daily/logs"
mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
chmod 0700 "${HOME}/.paperclip/instances/eliaquim/dominus-daily" "${LOG_DIR}"
chmod +x "${SCRIPT_DIR}/run-phase.sh" "${SCRIPT_DIR}/orchestrate.mjs"

while IFS=: read -r PHASE HOUR MINUTE; do
  LABEL="com.torriani.dominus-daily-${PHASE}"
  TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
  TEMP="$(mktemp -t dominus-daily.XXXXXX)"
  sed -e "s|__LABEL__|${LABEL}|g" -e "s|__RUNNER__|${SCRIPT_DIR}/run-phase.sh|g" -e "s|__PHASE__|${PHASE}|g" -e "s|__HOUR__|${HOUR}|g" -e "s|__MINUTE__|${MINUTE}|g" -e "s|__LOG_DIR__|${LOG_DIR}|g" "${TEMPLATE}" > "${TEMP}"
  plutil -lint "${TEMP}"
  install -m 0644 "${TEMP}" "${TARGET}"
  rm -f "${TEMP}"
  launchctl bootout "${USER_DOMAIN}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "${USER_DOMAIN}" "${TARGET}"
  launchctl enable "${USER_DOMAIN}/${LABEL}"
  echo "Installed ${LABEL} at ${HOUR}:${MINUTE}"
done < <(node -e 'const c=require(process.argv[1]); for(const p of c.phases) console.log(`${p.id}:${p.hour}:${p.minute}`)' "${CONFIG}")

LABEL="com.torriani.dominus-daily-watchdog"
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
TEMP="$(mktemp -t dominus-watchdog.XXXXXX)"
INTERVAL="$(node -e 'console.log(require(process.argv[1]).watchdog.intervalSeconds)' "${CONFIG}")"
sed -e "s|__LABEL__|${LABEL}|g" -e "s|__RUNNER__|${SCRIPT_DIR}/run-phase.sh|g" -e "s|__INTERVAL__|${INTERVAL}|g" -e "s|__LOG_DIR__|${LOG_DIR}|g" "${WATCHDOG_TEMPLATE}" > "${TEMP}"
plutil -lint "${TEMP}"
install -m 0644 "${TEMP}" "${TARGET}"
rm -f "${TEMP}"
launchctl bootout "${USER_DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${USER_DOMAIN}" "${TARGET}"
launchctl enable "${USER_DOMAIN}/${LABEL}"
echo "Installed ${LABEL} every ${INTERVAL}s"
