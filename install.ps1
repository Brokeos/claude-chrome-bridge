# Installation de Claude Code Bridge (Windows / PowerShell)
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

foreach ($cmd in "node", "npm", "claude") {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd introuvable dans le PATH." }
}
if ([int]((node -v) -replace '^v(\d+).*', '$1') -lt 20) { throw "Node.js 20 ou plus est requis." }

Write-Host "==> npm install"
Push-Location $root
npm install --omit=dev --no-fund --no-audit
Pop-Location

# Jeton aleatoire : seul un processus qui le connait peut piloter le navigateur.
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString("x2") })

Write-Host "==> Declaration du serveur MCP (scope user)"
claude mcp remove chrome-bridge --scope user 2>$null | Out-Null
claude mcp add chrome-bridge --scope user -e "CHROME_BRIDGE_TOKEN=$token" -- node (Join-Path $root "server\index.js")

Write-Host "==> Installation du skill"
$skillDir = Join-Path $HOME ".claude\skills\chrome-bridge"
New-Item -ItemType Directory -Force $skillDir | Out-Null
Copy-Item (Join-Path $root "skill\chrome-bridge\SKILL.md") $skillDir -Force

Write-Host ""
Write-Host "Reste a faire dans Chrome :"
Write-Host "  1. chrome://extensions -> Mode developpeur -> Charger l'extension non empaquetee"
Write-Host "     -> dossier $(Join-Path $root 'extension')"
Write-Host "  2. Popup de l'extension -> section Connexion -> colle ce jeton :"
Write-Host ""
Write-Host "     $token" -ForegroundColor Yellow
Write-Host ""
Write-Host "  3. Redemarre Claude Code."
