#!/usr/bin/env bash
# Installation de Claude Code Bridge (macOS / Linux)
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"

for cmd in node npm claude; do
  command -v "$cmd" >/dev/null || { echo "$cmd introuvable dans le PATH." >&2; exit 1; }
done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20 ou plus est requis." >&2; exit 1; }

echo "==> npm install"
(cd "$root" && npm install --omit=dev --no-fund --no-audit)

# Jeton aleatoire : seul un processus qui le connait peut piloter le navigateur.
token="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"

echo "==> Declaration du serveur MCP (scope user)"
claude mcp remove chrome-bridge --scope user >/dev/null 2>&1 || true
claude mcp add chrome-bridge --scope user -e "CHROME_BRIDGE_TOKEN=$token" -- node "$root/server/index.js"

echo "==> Installation du skill"
mkdir -p "$HOME/.claude/skills/chrome-bridge"
cp "$root/skill/chrome-bridge/SKILL.md" "$HOME/.claude/skills/chrome-bridge/"

cat <<MSG

Reste a faire dans Chrome :
  1. chrome://extensions -> Mode developpeur -> Charger l'extension non empaquetee
     -> dossier $root/extension
  2. Popup de l'extension -> section Connexion -> colle ce jeton :

     $token

  3. Redemarre Claude Code.
MSG
