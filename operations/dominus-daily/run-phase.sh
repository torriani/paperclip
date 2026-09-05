#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.npm-global/bin:${HOME}/.local/bin:${HOME}/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="${0:A:h}"
exec node "${SCRIPT_DIR}/orchestrate.mjs" "$@"
