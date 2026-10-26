# Claude Code Bridge

Partage un onglet Chrome **deja ouvert** avec Claude Code, qui peut alors le lire et interagir
avec — sans relancer le navigateur, sans profil dedie, avec tes sessions intactes.

## Pourquoi une extension plutot que CDP

Depuis Chrome 136, `--remote-debugging-port` est ignore quand il pointe sur le profil utilisateur
par defaut. L'attache CDP classique impose donc un `--user-data-dir` separe : nouveau profil,
reconnexion partout, redemarrage du navigateur. L'API `chrome.debugger` d'une extension n'a pas
cette limite : elle atteint n'importe quel onglet du profil reel, deja ouvert, sans aucun flag.

## Architecture

Un **broker** unique possede le port. L'extension s'y connecte une fois ; chaque conversation
Claude Code s'y branche comme client. C'est ce qui permet a plusieurs sessions de piloter le
meme navigateur — un serveur MCP par conversation ne peut pas posseder un port partage.

```
Conversation A --stdio--> server/index.js --\
                                             >-- ws://127.0.0.1:8777 --> server/broker.js
Conversation B --stdio--> server/index.js --/                                  |
                                                                    ws (une seule socket)
                                                                               |
                                                            extension/background.js (MV3)
                                                                  |  chrome.debugger.attach
                                                              Onglets partages
```

- `server/broker.js` — demon local : possede le port, route les appels, arbitre les onglets.
  Lance automatiquement par la premiere conversation, s'arrete seul apres 10 min sans session.
- `server/broker-client.js` — cote conversation : connexion, demarrage du demon, reconnexion.
- `server/index.js` — serveur MCP stdio, expose 19 outils `browser_*`.
- `server/protocol.js` — constantes partagees et version du protocole.
- `extension/background.js` — service worker : connexion WS, partage d'onglets, pilotage CDP.
- `extension/page-agent.js` — injecte dans la page : snapshot d'accessibilite, resolution des refs.
- `extension/popup.*` — partage des onglets et affectation aux conversations.

### Plusieurs conversations, plusieurs onglets

Par defaut, **tout onglet partage est visible par toutes les conversations** — c'est le cas
simple, quand une seule session est ouverte. Des que deux conversations travaillent en
parallele, on peut leur reserver des onglets :

- depuis Claude Code : `browser_claim_tab` / `browser_release_tab` ;
- depuis la popup : selecteur *Pilote par* sous chaque onglet partage.

Un onglet reserve disparait de la vue des autres conversations, et devient leur cible par
defaut pour celle qui l'a reserve. Les reservations sont liberees automatiquement quand la
conversation se ferme. `browser_sessions` liste qui est connecte et qui detient quoi.

### Survie du service worker

Un service worker MV3 est tue apres 30 s d'inactivite, ce qui coupait les appels en vol. Deux
parades : le broker envoie un message applicatif toutes les 10 s (seul un message **recu**
rearme le compteur cote Chromium — un ping sortant ou protocolaire ne suffit pas), et une
alarme `chrome.alarms` reveille le worker s'il meurt quand meme. Si un appel est interrompu
malgre tout, le broker le rejoue apres reconnexion — mais uniquement les commandes sans effet
de bord, pour ne jamais dupliquer un clic ou une frappe.

## Installation

Prerequis : Chrome 116+, Node.js 20+, Claude Code (`claude` dans le PATH).

**1. Script d'installation**

```bash
git clone <url-du-repo> claude-chrome-bridge
cd claude-chrome-bridge

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File .\install.ps1

# macOS / Linux
./install.sh
```

Le script installe les dependances, genere un **jeton aleatoire**, declare le serveur MCP
`chrome-bridge` dans Claude Code (scope user, avec le jeton) et copie le skill
`skill/chrome-bridge` dans `~/.claude/skills/`, qui apprend a Claude a se servir du pont.
Il affiche le jeton a la fin. Garde le dossier du repo a sa place : le MCP pointe dessus.

**2. Charger l'extension**

`chrome://extensions` → activer *Mode developpeur* → *Charger l'extension non empaquetee* →
choisir le dossier `extension/`.

**3. Coller le jeton**

Clique sur l'icone de l'extension → section *Connexion* → colle le jeton affiche par le script
→ enregistre. Redemarre ensuite Claude Code.

<details>
<summary>Installation manuelle</summary>

```bash
npm install
claude mcp add chrome-bridge --scope user -e CHROME_BRIDGE_TOKEN=<jeton> -- node /chemin/absolu/server/index.js
mkdir -p ~/.claude/skills/chrome-bridge && cp skill/chrome-bridge/SKILL.md ~/.claude/skills/chrome-bridge/
```

Puis colle le meme `<jeton>` dans la popup de l'extension.
</details>

**4. Utilisation**

Demande simplement a Claude Code une tache sur le web : il ouvre lui-meme ses onglets
(`browser_new_tab`). Tu peux aussi lui partager un onglet deja ouvert :
ouvre la page voulue, clique sur l'icone de l'extension, puis *Partager cet onglet*. Un badge `ON`
apparait sur l'onglet et Chrome affiche son bandeau jaune de debogage — c'est normal, et c'est le
signal visible que Claude Code a la main. Pour le masquer, lance Chrome avec
`--silent-debugger-extension-api` (a ajouter a la cible du raccourci, puis redemarrer Chrome
completement). Le bandeau n'est alors plus la pour revoquer : utilise *Retirer* dans la popup.

Rien n'est expose tant qu'aucun onglet n'est partage.

## Outils exposes

| Outil | Role |
|---|---|
| `browser_tabs` | Liste les onglets visibles par cette conversation |
| `browser_claim_tab` | Reserve un onglet pour cette conversation |
| `browser_release_tab` | Libere un onglet reserve |
| `browser_sessions` | Conversations connectees et onglets detenus |
| `browser_snapshot` | Arbre d'accessibilite compact avec refs `[ref=eN]` |
| `browser_click` | Clic reel (events trusted) sur une ref |
| `browser_type` | Saisie dans un champ, avec `clear` et `submit` |
| `browser_press_key` | Touche clavier, avec modificateurs |
| `browser_hover` | Survol |
| `browser_select_option` | Selection dans un `<select>` |
| `browser_scroll` | Defilement, ou vers un element |
| `browser_new_tab` | Ouvre un onglet, le partage et le reserve (sans partage prealable) |
| `browser_close_tab` | Ferme un onglet partage |
| `browser_navigate` | Navigation de l'onglet partage |
| `browser_evaluate` | Evaluation JS dans la page |
| `browser_screenshot` | Capture PNG, `fullPage` optionnel |
| `browser_console` | Messages console captures |
| `browser_network` | Requetes reseau capturees |
| `browser_wait_for` | Attente de texte, de disparition, ou delai |

Le flux normal est `browser_snapshot` → reperer une `[ref=eN]` → `browser_click` / `browser_type`.
Les refs sont invalidees a chaque nouveau snapshot : il faut recapturer apres une action qui
modifie la page.

## Configuration

| Variable | Defaut | Role |
|---|---|---|
| `CHROME_BRIDGE_PORT` | `8777` | Port WebSocket local |
| `CHROME_BRIDGE_TOKEN` | vide | Jeton partage, a recopier dans la popup |

Le port et le jeton se reglent aussi dans la section *Connexion* de la popup. Les deux cotes
doivent concorder.

## Securite

- **Partage explicite** : aucun onglet n'est accessible sans un clic dans la popup.
- **Filtre d'origine** : l'extension doit presenter un `Origin` en `chrome-extension://`. Une
  session Claude Code, elle, doit n'avoir **aucun** `Origin` — un navigateur en envoie toujours
  un, donc aucune page web ne peut se faire passer pour une conversation. Les deux voies sont
  fermees a un site malveillant.
- **Jeton** : `CHROME_BRIDGE_TOKEN` (genere par le script d'installation) ajoute un secret
  partage par-dessus le filtre. Sans lui, n'importe quel programme local ou n'importe quelle
  autre extension pourrait se brancher sur le pont : garde-le actif.
- **Ecoute locale uniquement** : le serveur se lie a `127.0.0.1`.
- **Revocation** : bouton *Retirer* dans la popup, ou fermeture du bandeau jaune de Chrome — les
  deux detachent le debogueur et retirent l'onglet du partage.
- **Etat non persistant** : la liste des onglets partages vit dans `chrome.storage.session` et
  disparait au redemarrage de Chrome.

## Tests

```bash
node scripts/smoke-test.mjs    # trajet complet MCP -> broker -> extension
node scripts/broker-test.mjs   # resilience du worker + multi-conversations
```

Le smoke test lance le serveur MCP, simule l'extension par un client WebSocket, et verifie le
trajet complet ainsi que le rejet des origines web et des jetons invalides.

`broker-test.mjs` couvre 17 proprietes : reservation et vol d'onglets, liberation a la
fermeture d'une conversation, affectation depuis la popup, keepalive applicatif, rejeu d'un
appel interrompu par la mort du worker, non-duplication d'un clic interrompu, remplacement de
socket, arret d'un broker obsolete et demarrage automatique du demon.

`scripts/fixture.html` sert a valider `page-agent.js` sur une vraie page (formulaire, etats,
elements masques, iframe meme-origine). Sers le dossier en HTTP puis ouvre la fixture — le
protocole `file://` empeche le chargement du script.

## A savoir avant de l'utiliser

Claude agit **avec tes sessions connectees** : tout ce que tu peux faire dans ton Chrome, il peut
le faire dans les onglets partages ou qu'il ouvre (y compris executer du JS avec
`browser_evaluate` et envoyer un fichier local avec `browser_upload_file`). Une page malveillante
peut tenter de lui donner des instructions (injection de prompt). Garde les confirmations de
Claude Code actives pour ces outils si tu n'es pas sur de toi, et retire les onglets sensibles
du partage quand tu as fini.

## Limites connues

- **Un seul debogueur par onglet** : si les DevTools sont ouverts sur l'onglet partage, l'attache
  echoue. Ferme-les.
- **Iframes d'origine differente** : leur contenu n'apparait pas dans le snapshot. Les iframes de
  meme origine sont traversees, coordonnees comprises.
- **Elements hors ecran** : `browser_click` refuse un element dont le centre sort du viewport
  apres defilement, plutot que de cliquer a cote. Agrandis la fenetre ou fais defiler.
- **Capture d'ecran** : l'onglet est active au premier plan avant la capture, car un onglet en
  arriere-plan a son rendu bride.
- **Shadow DOM** : non traverse dans cette version.
