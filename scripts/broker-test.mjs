/**
 * Suite de tests du pont.
 *
 * Couvre les deux proprietes qui comptent :
 *  - la resilience : un service worker MV3 meurt toutes les 30 s, le pont doit survivre ;
 *  - le multi-conversations : plusieurs sessions Claude Code partagent un seul navigateur,
 *    avec reservation d'onglets pour qu'elles ne se marchent pas dessus.
 *
 * Usage : node scripts/broker-test.mjs
 */
import { WebSocket } from "ws";
import { Broker } from "../server/broker.js";
import { BrokerClient } from "../server/broker-client.js";

const PORT = 8901;
const SPAWN_PORT = 8902;
const EXT_ORIGIN = "chrome-extension://faketestextension";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const silent = () => {};

function check(label, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `\n       -> ${detail}`}`);
  if (!ok) failures++;
}

const TABS = [
  { id: 1, title: "Onglet un", url: "https://un.example", primary: true },
  { id: 2, title: "Onglet deux", url: "https://deux.example", primary: false },
];

/** Faux service worker : repond aux commandes et compte les keepalives recus. */
function fakeExtension(port, { onCall, tabs = TABS } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: EXT_ORIGIN });
  ws.keepalives = 0;
  ws.sessionsSeen = null;
  ws.calls = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "keepalive") return void ws.keepalives++;
    if (msg.type === "event" && msg.event === "sessions") {
      ws.sessionsSeen = msg;
      return;
    }
    if (msg.type !== "call") return;
    ws.calls.push(msg);
    onCall?.(ws, msg);
  });

  return new Promise((resolve) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "event", event: "tabs", tabs }));
      setTimeout(() => resolve(ws), 80);
    });
  });
}

const reply = (ws, msg, data) =>
  ws.send(JSON.stringify({ id: msg.id, type: "result", ok: true, data }));

/** Client MCP brut, pour tester les cas que BrokerClient n'expose pas. */
function rawSession(port, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?role=mcp&label=${label}`);
  return new Promise((resolve) => ws.on("open", () => resolve(ws)));
}

// ============================================================ broker principal

const broker = new Broker({ port: PORT, log: silent, idleShutdownMs: 0 });
await broker.start();

let ext = await fakeExtension(PORT, { onCall: (ws, m) => reply(ws, m, { echo: m.method }) });

const alice = new BrokerClient({ port: PORT, label: "alice", log: silent });
const bob = new BrokerClient({ port: PORT, label: "bob", log: silent });
await alice.start();
await bob.start();
await sleep(150);

// --- 1. securite du controle d'acces ---------------------------------------
const webPageRejected = await new Promise((resolve) => {
  // Une page web ne peut pas se faire passer pour une session : elle envoie un Origin.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?role=mcp&label=evil`, {
    origin: "https://evil.example",
  });
  ws.on("open", () => resolve(false));
  ws.on("error", () => resolve(true));
});
check("une page web ne peut pas se connecter en tant que session MCP", webPageRejected);

// --- 2. multi-sessions : vue partagee par defaut ----------------------------
const aliceTabs = await alice.call("list_tabs");
const bobTabs = await bob.call("list_tabs");
check(
  "deux conversations voient les memes onglets non reserves",
  aliceTabs.length === 2 && bobTabs.length === 2,
  `alice=${aliceTabs.length} bob=${bobTabs.length}`,
);

const sessionList = await alice.call("list_sessions");
check(
  "chaque conversation est listee, la sienne est marquee",
  sessionList.length === 2 && sessionList.find((s) => s.label === "alice")?.self === true,
  JSON.stringify(sessionList),
);

// --- 3. reservation d'onglet ------------------------------------------------
await alice.call("claim_tab", { tabId: 1 });
await sleep(120);
const bobAfterClaim = await bob.call("list_tabs");
check(
  "un onglet reserve par alice disparait de la vue de bob",
  bobAfterClaim.length === 1 && bobAfterClaim[0].id === 2,
  JSON.stringify(bobAfterClaim.map((t) => t.id)),
);

const bobBlocked = await bob
  .call("snapshot", { tabId: 1 })
  .then(() => null)
  .catch((e) => e.message);
check(
  "bob qui cible l'onglet reserve recoit une erreur explicite",
  typeof bobBlocked === "string" && /reserve/i.test(bobBlocked),
  bobBlocked,
);

const aliceTabsAfter = await alice.call("list_tabs");
check(
  "pour alice, l'onglet reserve devient la cible par defaut",
  aliceTabsAfter.find((t) => t.id === 1)?.primary === true,
  JSON.stringify(aliceTabsAfter.map((t) => [t.id, t.primary])),
);

const stolen = await bob
  .call("claim_tab", { tabId: 1 })
  .then(() => null)
  .catch((e) => e.message);
check(
  "bob ne peut pas voler un onglet deja reserve",
  typeof stolen === "string" && /deja reserve/i.test(stolen),
  stolen,
);

check(
  "l'extension recoit la liste des conversations pour sa popup",
  ext.sessionsSeen?.sessions?.length === 2 && ext.sessionsSeen.assignments["1"] === "s1",
  JSON.stringify(ext.sessionsSeen),
);

await alice.call("release_tab", { tabId: 1 });
await sleep(120);
check("apres liberation, bob revoit l'onglet", (await bob.call("list_tabs")).length === 2);

// --- 4. la fermeture d'une conversation libere ses onglets ------------------
await alice.call("claim_tab", { tabId: 2 });
await sleep(100);
alice.close();
await sleep(250);
check(
  "fermer une conversation libere ses reservations",
  (await bob.call("list_tabs")).length === 2,
);

// --- 5. affectation pilotee depuis la popup --------------------------------
ext.send(JSON.stringify({ type: "event", event: "assign", tabId: 2, sessionId: "s2" }));
await sleep(150);
const bobOwned = await bob.call("list_sessions");
check(
  "la popup peut reserver un onglet pour une conversation",
  bobOwned.find((s) => s.id === "s2")?.tabs.includes(2),
  JSON.stringify(bobOwned),
);
ext.send(JSON.stringify({ type: "event", event: "assign", tabId: 2, sessionId: null }));
await sleep(150);

// --- 6. keepalive applicatif ------------------------------------------------
await sleep(10_500);
check("le broker emet un keepalive applicatif (garde le worker MV3 en vie)", ext.keepalives >= 1);

// --- 7. resilience : worker tue en plein appel ------------------------------
let died = false;
ext.removeAllListeners("message");
ext.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== "call") return;
  if (!died) {
    died = true;
    ext.terminate(); // Chromium tue le service worker au bout de 30 s d'inactivite
    setTimeout(async () => {
      ext = await fakeExtension(PORT, {
        onCall: (ws, m) => reply(ws, m, { echo: m.method, replayed: true }),
      });
    }, 400);
  }
});

const replayed = await bob.call("snapshot", { tabId: 2 }, 15_000).catch((e) => ({ error: e.message }));
check(
  "un snapshot interrompu par la mort du worker est rejoue et aboutit",
  replayed?.replayed === true,
  JSON.stringify(replayed),
);

// --- 8. une commande a effet de bord n'est pas rejouee en double ------------
let died2 = false;
ext.removeAllListeners("message");
ext.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== "call") return;
  if (!died2) {
    died2 = true;
    ext.terminate();
    setTimeout(async () => {
      ext = await fakeExtension(PORT, { onCall: (ws, m) => reply(ws, m, { description: "bouton" }) });
    }, 400);
  }
});

const clicked = await bob
  .call("click", { tabId: 2, ref: "e1" }, 15_000)
  .then(() => "rejoue")
  .catch((e) => e.message);
check(
  "un click interrompu echoue explicitement au lieu d'etre duplique",
  typeof clicked === "string" && /service worker/i.test(clicked),
  clicked,
);

// --- 9. remplacement de socket ----------------------------------------------
const ext2 = await fakeExtension(PORT, { onCall: (ws, m) => reply(ws, m, { echo: "nouvelle socket" }) });
await sleep(200);
const afterReplace = await bob.call("snapshot", { tabId: 1 }).catch((e) => ({ error: e.message }));
check(
  "apres remplacement de la socket extension, les appels passent sur la nouvelle",
  afterReplace?.echo === "nouvelle socket",
  JSON.stringify(afterReplace),
);
void ext2;

// --- 10. arret sur demande (protocole obsolete) -----------------------------
let exited = false;
broker.onExit = () => {
  exited = true;
};
const raw = await rawSession(PORT, "upgrader");
raw.send(JSON.stringify({ type: "shutdown", reason: "test" }));
await sleep(300);
check("un client peut demander l'arret d'un broker obsolete", exited);

bob.close();
broker.stop();
await sleep(200);

// ==================================================== demarrage automatique

// Aucun broker sur ce port : le client doit en lancer un tout seul, en arriere-plan.
const solo = new BrokerClient({ port: SPAWN_PORT, label: "solo", log: silent });
await solo.start().catch(() => {});
const spawnedSessions = await solo.call("list_sessions").catch((e) => ({ error: e.message }));
check(
  "une session sans broker en lance un automatiquement",
  Array.isArray(spawnedSessions) && spawnedSessions.some((s) => s.label === "solo"),
  JSON.stringify(spawnedSessions),
);

// Menage : on demande au demon de sortir plutot que de le laisser trainer.
const closer = await rawSession(SPAWN_PORT, "closer");
closer.send(JSON.stringify({ type: "shutdown", reason: "fin des tests" }));
solo.close();
await sleep(400);

console.log(failures ? `\n${failures} echec(s)` : "\nTout est vert");
process.exit(failures ? 1 : 0);
