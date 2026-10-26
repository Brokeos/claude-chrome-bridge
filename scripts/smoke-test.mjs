/**
 * Test de bout en bout sans Chrome.
 *
 * Lance le serveur MCP, simule l'extension par un client WebSocket, et verifie
 * le trajet complet : outil MCP -> pont WS -> "extension" -> reponse -> outil MCP.
 * Verifie aussi que le filtre d'origine rejette une connexion venue d'une page web.
 *
 * Usage : node scripts/smoke-test.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "server", "index.js");
const PORT = 8899;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, condition, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "OK  " : "FAIL"} ${label}${!condition && detail ? ` -> ${detail}` : ""}`);
}

const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, CHROME_BRIDGE_PORT: String(PORT), CHROME_BRIDGE_TOKEN: "s3cret" },
  stdio: ["pipe", "pipe", "pipe"],
});
server.stderr.on("data", () => {}); // logs du serveur : ignores ici

// --- lecture des reponses JSON-RPC ---------------------------------------
const pendingRpc = new Map();
let rpcBuf = "";
server.stdout.on("data", (chunk) => {
  rpcBuf += chunk.toString();
  const lines = rpcBuf.split("\n");
  rpcBuf = lines.pop() ?? "";
  for (const line of lines.filter(Boolean)) {
    const msg = JSON.parse(line);
    const resolve = pendingRpc.get(msg.id);
    if (resolve) {
      pendingRpc.delete(msg.id);
      resolve(msg);
    }
  }
});

let rpcId = 0;
function rpc(method, params) {
  const id = ++rpcId;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, resolve);
    setTimeout(() => reject(new Error(`Timeout RPC ${method}`)), 10_000);
  });
}

function notify(method) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

// --- faux client "extension" ---------------------------------------------
function openFakeExtension({ token, origin = "chrome-extension://fakeid" }) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${PORT}/${token ? `?token=${token}` : ""}`;
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
    socket.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const FAKE_TABS = [
  { id: 42, title: "Tableau de bord", url: "https://exemple.test/dashboard", primary: true },
];

try {
  await sleep(700);

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  check("initialize repond", init.result?.serverInfo?.name === "chrome-bridge");
  notify("notifications/initialized");

  // 1. Une origine de page web doit etre refusee.
  let rejected = false;
  try {
    await openFakeExtension({ token: "s3cret", origin: "https://site-malveillant.test" });
  } catch (err) {
    rejected = /403/.test(err.message);
  }
  check("origine web rejetee (403)", rejected);

  // 2. Un mauvais jeton doit etre refuse.
  let badToken = false;
  try {
    await openFakeExtension({ token: "mauvais" });
  } catch (err) {
    badToken = /401/.test(err.message);
  }
  check("jeton invalide rejete (401)", badToken);

  // 3. La vraie extension se connecte et annonce ses onglets.
  const ext = await openFakeExtension({ token: "s3cret" });
  const calls = [];
  ext.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "call") return;
    calls.push(msg.method);
    const data =
      msg.method === "list_tabs"
        ? FAKE_TABS
        : {
            url: "https://exemple.test/dashboard",
            title: "Tableau de bord",
            viewport: { width: 1280, height: 720, scrollY: 0, scrollHeight: 2400 },
            count: 2,
            truncated: false,
            tree: '- heading "Ventes" [ref=e0]\n- button "Exporter" [ref=e1]',
          };
    ext.send(JSON.stringify({ id: msg.id, type: "result", ok: true, data }));
  });
  ext.send(JSON.stringify({ type: "event", event: "tabs", tabs: FAKE_TABS }));
  await sleep(300);

  // 4. browser_tabs traverse tout le pont.
  const tabs = await rpc("tools/call", { name: "browser_tabs", arguments: {} });
  const tabsText = tabs.result.content[0].text;
  check("browser_tabs liste l'onglet partage", tabsText.includes("Tableau de bord"), tabsText);
  // Le broker tient lui-meme le registre des onglets : inutile de reveiller le service
  // worker pour une simple lecture, et la vue est filtree par conversation au passage.
  check("list_tabs est servi par le broker sans solliciter l'extension", !calls.includes("list_tabs"));

  // 5. browser_snapshot resout l'onglet cible tout seul et met en forme le resultat.
  const snap = await rpc("tools/call", { name: "browser_snapshot", arguments: {} });
  const snapText = snap.result.content[0].text;
  check("browser_snapshot renvoie l'arbre", snapText.includes('button "Exporter" [ref=e1]'), snapText);
  check("browser_snapshot ajoute l'entete URL", snapText.includes("https://exemple.test/dashboard"));

  // 6. Un tabId inconnu produit une erreur explicite plutot qu'un plantage.
  const bad = await rpc("tools/call", { name: "browser_snapshot", arguments: { tabId: 999 } });
  check(
    "tabId inconnu -> erreur lisible",
    bad.result.isError === true && bad.result.content[0].text.includes("n'est pas partage"),
    bad.result.content[0].text,
  );

  ext.close();
} catch (err) {
  failures++;
  console.log(`FAIL exception : ${err.message}`);
} finally {
  server.kill();
  // Le serveur MCP a lance un broker detache : il survivrait au test. On lui demande de
  // sortir, sinon il squatterait le port jusqu'a son arret pour inactivite.
  await new Promise((resolve) => {
    const closer = new WebSocket(`ws://127.0.0.1:${PORT}/?role=mcp&label=closer&token=s3cret`);
    closer.on("open", () => {
      closer.send(JSON.stringify({ type: "shutdown", reason: "fin du smoke test" }));
      setTimeout(resolve, 300);
    });
    closer.on("error", resolve);
  });
}

console.log(failures === 0 ? "\nTous les tests passent." : `\n${failures} test(s) en echec.`);
process.exit(failures === 0 ? 0 : 1);
