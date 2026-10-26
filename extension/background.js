/**
 * Service worker de l'extension.
 *
 * Role : maintenir la connexion WebSocket vers le serveur MCP local, gerer la liste
 * des onglets explicitement partages par l'utilisateur, et executer les commandes
 * recues en pilotant l'onglet via chrome.debugger (Chrome DevTools Protocol).
 *
 * Rien n'est accessible tant que l'utilisateur n'a pas partage un onglet depuis la popup.
 */

const DEFAULT_PORT = 8777;
const KEEPALIVE_MS = 20_000;
const KEEPALIVE_ALARM = "ccb-keepalive";
const BUFFER_MAX = 300;

let ws = null;
let connecting = false;
let reconnectTimer = null;
let keepaliveTimer = null;
let backoffMs = 1000;
let agentSource = null;

/** tabId -> { title, url, sharedAt } */
const shared = new Map();
let primaryTabId = null;

/** Conversations Claude Code connectees au broker, pour l'affichage dans la popup. */
let sessions = [];
/** tabId -> sessionId : onglets reserves a une conversation precise. */
let assignments = {};

const attached = new Set();
const consoleBuf = new Map();
const networkBuf = new Map();
const networkIndex = new Map();

// ---------------------------------------------------------------- persistance

async function loadConfig() {
  const cfg = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
  return { port: Number(cfg.port) || DEFAULT_PORT, token: cfg.token || "" };
}

async function saveState() {
  await chrome.storage.session.set({ shared: [...shared.entries()], primaryTabId });
}

async function restoreState() {
  const { shared: saved, primaryTabId: savedPrimary } = await chrome.storage.session.get({
    shared: [],
    primaryTabId: null,
  });
  shared.clear();
  for (const [id, meta] of saved) {
    // Un onglet peut avoir ete ferme pendant que le service worker dormait.
    try {
      await chrome.tabs.get(Number(id));
      shared.set(Number(id), meta);
    } catch {
      /* onglet disparu : on l'oublie */
    }
  }
  primaryTabId = shared.has(savedPrimary) ? savedPrimary : (shared.keys().next().value ?? null);
  await refreshBadges();
}

async function refreshBadges() {
  for (const tabId of shared.keys()) {
    try {
      await chrome.action.setBadgeText({ tabId, text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c96442" });
    } catch {
      /* onglet ferme entre-temps */
    }
  }
}

// ------------------------------------------------------------------ WebSocket

async function connect() {
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // loadConfig() est asynchrone : sans ce verrou, deux appels concurrents (alarme +
  // demarrage, ou fermeture + reconnexion) franchiraient tous deux le garde ci-dessus
  // et ouvriraient deux sockets pour une seule extension.
  if (connecting) return;
  connecting = true;

  let sock;
  try {
    const { port, token } = await loadConfig();
    const url = `ws://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    sock = new WebSocket(url);
  } catch {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = sock;
  connecting = false;

  // Tous les handlers se referent a `sock`, jamais a la globale `ws` : une socket que
  // l'on remplace se ferme *apres* que la suivante a ete installee, et sans ce garde
  // son onclose remettrait `ws` a null alors que la nouvelle est bien vivante. Le pont
  // resterait alors connecte vu du broker, mais muet (send() ne verifie que `ws`).
  const current = () => ws === sock;

  sock.onopen = () => {
    if (!current()) return void sock.close();
    backoffMs = 1000;
    pushTabs();
    clearInterval(keepaliveTimer);
    // Ce ping sortant ne suffit pas a garder le worker eveille (seuls les messages
    // *recus* rearment le compteur d'inactivite) : c'est le keepalive du serveur qui
    // joue ce role. On le garde pour detecter une socket morte cote extension.
    keepaliveTimer = setInterval(() => {
      if (!current()) return void clearInterval(keepaliveTimer);
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: "event", event: "ping" }));
      }
    }, KEEPALIVE_MS);
  };

  sock.onmessage = (evt) => {
    if (!current()) return;
    handleMessage(evt.data);
  };

  sock.onclose = (evt) => {
    if (!current()) return; // socket deja remplacee : la nouvelle fait foi
    ws = null;
    clearInterval(keepaliveTimer);
    // Code 4000 : le serveur nous a expulses au profit d'une autre connexion. Revenir
    // a la charge tout de suite produirait un ping-pong sans fin, mais attendre trop
    // laisse le pont muet : quelques secondes suffisent a departager deux clients.
    if (evt && evt.code === 4000) backoffMs = 5_000;
    scheduleReconnect();
  };

  sock.onerror = () => {
    // onclose suit systematiquement : la reconnexion est geree la-bas.
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function pushTabs() {
  send({ type: "event", event: "tabs", tabs: await tabList() });
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // Le keepalive n'a rien a faire : le simple fait de le *recevoir* rearme le compteur
  // d'inactivite du service worker, ce qui est tout son interet.
  if (msg.type === "keepalive") return;

  if (msg.type === "event" && msg.event === "sessions") {
    sessions = msg.sessions ?? [];
    assignments = msg.assignments ?? {};
    return;
  }

  if (msg.type !== "call") return;

  const handler = commands[msg.method];
  if (!handler) {
    send({ id: msg.id, type: "result", ok: false, error: `Methode inconnue : ${msg.method}` });
    return;
  }

  try {
    const data = await handler(msg.params ?? {});
    send({ id: msg.id, type: "result", ok: true, data });
  } catch (err) {
    send({ id: msg.id, type: "result", ok: false, error: err?.message ?? String(err) });
  }
}

// ------------------------------------------------------------ pilotage du CDP

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method} : ${err.message}`));
      else resolve(result);
    });
  });
}

function assertShared(tabId) {
  if (!shared.has(tabId)) {
    throw new Error(
      `L'onglet ${tabId} n'est plus partage. Ouvre la popup de l'extension pour le repartager.`,
    );
  }
}

async function ensureAttached(tabId) {
  assertShared(tabId);
  if (attached.has(tabId)) return;

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (!err) return resolve();
      if (/another debugger|devtools/i.test(err.message)) {
        return reject(
          new Error(
            "Un autre debogueur est deja attache a cet onglet (DevTools ouverts ?). " +
              "Ferme les DevTools de cet onglet puis reessaie.",
          ),
        );
      }
      if (/already attached/i.test(err.message)) return resolve();
      reject(new Error(err.message));
    });
  });

  attached.add(tabId);
  if (!consoleBuf.has(tabId)) consoleBuf.set(tabId, []);
  if (!networkBuf.has(tabId)) networkBuf.set(tabId, []);
  if (!networkIndex.has(tabId)) networkIndex.set(tabId, new Map());

  await cdp(tabId, "Runtime.enable");
  await cdp(tabId, "Log.enable");
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Network.enable");
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function getAgentSource() {
  if (!agentSource) {
    const res = await fetch(chrome.runtime.getURL("page-agent.js"));
    agentSource = await res.text();
  }
  return agentSource;
}

/** Evalue une expression dans le contexte principal de la page et renvoie sa valeur. */
async function evalIn(tabId, expression, awaitPromise = true) {
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails;
    const text = ex.exception?.description ?? ex.text ?? "Exception dans la page";
    throw new Error(String(text).split("\n")[0]);
  }
  return res.result?.value;
}

async function ensureAgent(tabId) {
  await ensureAttached(tabId);
  const present = await evalIn(tabId, "!!(window.__CCB__ && window.__CCB__.v === 2)", false);
  if (present === true) return;
  await evalIn(tabId, await getAgentSource(), false);
}

/** Appelle une methode de window.__CCB__ avec des arguments serialises en JSON. */
async function agentCall(tabId, method, args = []) {
  await ensureAgent(tabId);
  const call = `window.__CCB__.${method}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
  const result = await evalIn(tabId, call, false);
  if (result && result.ok === false) throw new Error(result.error);
  return result;
}

// --------------------------------------------------------- evenements du CDP

function pushConsole(tabId, msg) {
  const buf = consoleBuf.get(tabId) ?? [];
  buf.push(msg);
  if (buf.length > BUFFER_MAX) buf.shift();
  consoleBuf.set(tabId, buf);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !attached.has(tabId)) return;

  if (method === "Runtime.consoleAPICalled") {
    pushConsole(tabId, {
      level: params.type,
      text: (params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type)
        .join(" "),
      url: params.stackTrace?.callFrames?.[0]?.url ?? "",
    });
  } else if (method === "Runtime.exceptionThrown") {
    const ex = params.exceptionDetails;
    pushConsole(tabId, {
      level: "error",
      text: ex?.exception?.description ?? ex?.text ?? "Exception",
      url: ex?.url ?? "",
    });
  } else if (method === "Log.entryAdded") {
    pushConsole(tabId, {
      level: params.entry.level,
      text: params.entry.text,
      url: params.entry.url ?? "",
    });
  } else if (method === "Network.requestWillBeSent") {
    const entry = { method: params.request.method, url: params.request.url, status: null, error: null };
    const buf = networkBuf.get(tabId) ?? [];
    buf.push(entry);
    if (buf.length > BUFFER_MAX) buf.shift();
    networkBuf.set(tabId, buf);
    networkIndex.get(tabId)?.set(params.requestId, entry);
  } else if (method === "Network.responseReceived") {
    const entry = networkIndex.get(tabId)?.get(params.requestId);
    if (entry) entry.status = params.response.status;
  } else if (method === "Network.loadingFailed") {
    const entry = networkIndex.get(tabId)?.get(params.requestId);
    if (entry) entry.error = params.errorText;
  } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
    // Nouvelle page : l'agent injecte a disparu, il sera reinjecte au prochain appel.
    const meta = shared.get(tabId);
    if (meta) {
      meta.url = params.frame.url;
      saveState();
      pushTabs();
    }
  }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  attached.delete(tabId);
  if (reason === "canceled_by_user") {
    // L'utilisateur a ferme le bandeau de debogage : le partage est considere revoque.
    await unshare(tabId);
  }
});

// --------------------------------------------------------- gestion du partage

async function share(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|edge|devtools|chrome-extension|about):/i.test(tab.url ?? "")) {
    throw new Error("Les pages internes de Chrome ne peuvent pas etre partagees.");
  }
  shared.set(tabId, { title: tab.title ?? "", url: tab.url ?? "", sharedAt: Date.now() });
  primaryTabId = tabId;
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c96442" });
  // Publier le partage avant d'attacher le debogueur : si l'attache echoue (DevTools
  // ouverts sur l'onglet), la popup afficherait sinon un onglet partage que Claude Code
  // ne verrait jamais. L'attache est de toute facon retentee a chaque commande.
  await saveState();
  await pushTabs();
  await ensureAttached(tabId);
}

async function unshare(tabId) {
  shared.delete(tabId);
  consoleBuf.delete(tabId);
  networkBuf.delete(tabId);
  networkIndex.delete(tabId);
  if (primaryTabId === tabId) primaryTabId = shared.keys().next().value ?? null;
  await detach(tabId);
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch {
    /* onglet ferme */
  }
  await saveState();
  await pushTabs();
}

async function tabList() {
  const out = [];
  for (const [id, meta] of [...shared]) {
    try {
      const tab = await chrome.tabs.get(id);
      meta.title = tab.title ?? meta.title;
      meta.url = tab.url ?? meta.url;
      out.push({ id, title: meta.title, url: meta.url, primary: id === primaryTabId });
    } catch {
      shared.delete(id);
    }
  }
  return out;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (shared.has(tabId)) unshare(tabId);
});

// ------------------------------------------------------------ entrees clavier

const KEY_MAP = {
  Enter: { code: "Enter", key: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", key: "Tab", keyCode: 9 },
  Escape: { code: "Escape", key: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", key: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", key: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", key: "Home", keyCode: 36 },
  End: { code: "End", key: "End", keyCode: 35 },
  PageUp: { code: "PageUp", key: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", key: "PageDown", keyCode: 34 },
  Space: { code: "Space", key: " ", keyCode: 32, text: " " },
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function keyDescriptor(key) {
  if (KEY_MAP[key]) return KEY_MAP[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      code: /[a-z]/i.test(key) ? `Key${upper}` : `Digit${key}`,
      key,
      keyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  throw new Error(`Touche non reconnue : "${key}".`);
}

async function pressKey(tabId, key, modifiers = []) {
  const desc = keyDescriptor(key);
  const mask = modifiers.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0);
  const base = {
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.keyCode,
    nativeVirtualKeyCode: desc.keyCode,
    modifiers: mask,
  };
  // Un keyDown porteur de texte genere le keypress attendu par les pages ;
  // avec un modificateur, rawKeyDown evite d'inserer un caractere parasite.
  await cdp(tabId, "Input.dispatchKeyEvent", {
    ...base,
    type: desc.text && !mask ? "keyDown" : "rawKeyDown",
    text: mask ? undefined : desc.text,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

async function mouseClick(tabId, x, y, { button = "left", clickCount = 1 } = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: BUTTON_MASK[button] ?? 1,
      clickCount: i,
    });
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: i,
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ commandes

const commands = {
  async list_tabs() {
    return tabList();
  },

  async snapshot({ tabId, maxNodes }) {
    return agentCall(tabId, "snapshot", [maxNodes ?? 1200]);
  },

  async click({ tabId, ref, doubleClick, button }) {
    const info = await agentCall(tabId, "rect", [ref]);
    if (info.offScreen) {
      throw new Error(
        `${info.description} n'est pas atteignable dans la fenetre visible ` +
          `(taille ${info.width}x${info.height}). Fais defiler la page ou agrandis la fenetre.`,
      );
    }
    await mouseClick(tabId, info.x, info.y, {
      button: button ?? "left",
      clickCount: doubleClick ? 2 : 1,
    });
    return { description: info.description };
  },

  async type({ tabId, ref, text, clear, submit }) {
    const info = await agentCall(tabId, "rect", [ref]);
    if (!info.offScreen) await mouseClick(tabId, info.x, info.y);
    await agentCall(tabId, "focusRef", [ref]);

    if (clear) {
      const state = await agentCall(tabId, "selectAll", [ref]);
      // insertText remplace la selection ; sans texte a inserer il faut supprimer.
      if (state.hadValue && !text) await pressKey(tabId, "Delete");
    }
    if (text) await cdp(tabId, "Input.insertText", { text });
    if (submit) await pressKey(tabId, "Enter");
    return { description: info.description };
  },

  async press_key({ tabId, key, modifiers }) {
    await ensureAttached(tabId);
    await pressKey(tabId, key, modifiers ?? []);
    return { ok: true };
  },

  async hover({ tabId, ref }) {
    const info = await agentCall(tabId, "rect", [ref]);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: info.x,
      y: info.y,
      button: "none",
      buttons: 0,
    });
    return { description: info.description };
  },

  async upload_file({ tabId, ref, selector, files }) {
    if (!Array.isArray(files) || !files.length) throw new Error("Aucun fichier a envoyer.");
    await ensureAgent(tabId);
    // Sans ref ni selector, on prend le premier <input type=file> de la page : les panneaux
    // d'upload (Pterodactyl, etc.) le gardent cache, il n'apparait donc pas dans le snapshot.
    const expr = ref
      ? `window.__CCB__.lookup(${JSON.stringify(ref)})`
      : `document.querySelector(${JSON.stringify(selector || "input[type=file]")})`;
    const res = await cdp(tabId, "Runtime.evaluate", { expression: expr, returnByValue: false });
    if (res.exceptionDetails) throw new Error("Impossible de localiser le champ fichier.");
    const objectId = res.result?.objectId;
    if (!objectId || res.result?.subtype === "null") {
      throw new Error(ref ? `Reference ${ref} introuvable.` : "Aucun champ <input type=file> trouve.");
    }
    const type = await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){return this.tagName === 'INPUT' && this.type === 'file';}",
      returnByValue: true,
    });
    if (type.result?.value !== true) throw new Error("L'element cible n'est pas un <input type=file>.");
    await cdp(tabId, "DOM.setFileInputFiles", { objectId, files });
    // setFileInputFiles declenche input/change cote navigateur ; rien d'autre a faire.
    return { count: files.length };
  },

  async select_option({ tabId, ref, values }) {
    const res = await agentCall(tabId, "setSelect", [ref, values]);
    return { description: res.description, selected: res.selected };
  },

  async scroll({ tabId, ref, deltaX, deltaY }) {
    if (ref) return agentCall(tabId, "scrollToRef", [ref]);
    return agentCall(tabId, "scrollBy", [deltaX ?? 0, deltaY ?? 600]);
  },

  async new_tab({ url, active }) {
    if (!/^https?:\/\//i.test(url ?? "")) {
      throw new Error("browser_new_tab attend une URL absolue http(s).");
    }
    // En arriere-plan par defaut : ne pas voler le focus de l'utilisateur.
    const tab = await chrome.tabs.create({ url, active: active ?? false });
    await share(tab.id);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(250);
      try {
        if ((await evalIn(tab.id, "document.readyState", false)) === "complete") break;
      } catch {
        /* page pas encore prete : on retente */
      }
    }
    const done = await chrome.tabs.get(tab.id);
    const meta = shared.get(tab.id);
    if (meta) {
      meta.url = done.url ?? url;
      meta.title = done.title ?? "";
      await saveState();
      await pushTabs();
    }
    return { tabId: tab.id, url: done.url ?? url, title: done.title ?? "" };
  },

  async close_tab({ tabId }) {
    assertShared(tabId);
    await chrome.tabs.remove(tabId); // onRemoved se charge de retirer le partage
    return { ok: true };
  },

  async navigate({ tabId, url }) {
    await ensureAttached(tabId);
    await cdp(tabId, "Page.navigate", { url });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(250);
      try {
        if ((await evalIn(tabId, "document.readyState", false)) === "complete") break;
      } catch {
        /* contexte detruit pendant la navigation : on retente */
      }
    }
    const tab = await chrome.tabs.get(tabId);
    const meta = shared.get(tabId);
    if (meta) {
      meta.url = tab.url ?? url;
      meta.title = tab.title ?? "";
      await saveState();
      await pushTabs();
    }
    return { url: tab.url ?? url, title: tab.title ?? "" };
  },

  async evaluate({ tabId, expression }) {
    await ensureAttached(tabId);
    // La serialisation est faite dans la page : le retour est toujours une chaine lisible.
    const wrapped = `(async () => {
      const __v = await (${expression});
      if (typeof __v === "undefined") return "undefined";
      if (__v === null) return "null";
      if (typeof __v === "string") return __v;
      try {
        return JSON.stringify(__v, (k, val) =>
          (val && val.nodeType) ? "<" + val.nodeName.toLowerCase() + ">" : val, 2);
      } catch (e) {
        return String(__v);
      }
    })()`;
    const result = await evalIn(tabId, wrapped, true);
    return { result: String(result ?? "") };
  },

  async screenshot({ tabId, fullPage }) {
    await ensureAttached(tabId);
    // Un onglet en arriere-plan a son rendu bride : sans activation la capture peut rester vide.
    await chrome.tabs.update(tabId, { active: true });
    await sleep(120);

    let params = { format: "png" };
    if (fullPage) {
      const metrics = await cdp(tabId, "Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      params = {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.min(size.width, 4000),
          height: Math.min(size.height, 8000),
          scale: 1,
        },
      };
    }
    const res = await cdp(tabId, "Page.captureScreenshot", params);
    const tab = await chrome.tabs.get(tabId);
    return { data: res.data, url: tab.url ?? "" };
  },

  async console_messages({ tabId, level, limit }) {
    assertShared(tabId);
    let messages = consoleBuf.get(tabId) ?? [];
    if (level === "error") {
      messages = messages.filter((m) => m.level === "error");
    } else if (level === "warning") {
      messages = messages.filter((m) => m.level === "warning" || m.level === "warn");
    }
    return { messages: messages.slice(-(limit ?? 50)) };
  },

  async network_requests({ tabId, filter, failedOnly, limit }) {
    assertShared(tabId);
    let requests = networkBuf.get(tabId) ?? [];
    if (filter) requests = requests.filter((r) => r.url.includes(filter));
    if (failedOnly) requests = requests.filter((r) => r.error || (r.status ?? 0) >= 400);
    return { requests: requests.slice(-(limit ?? 50)) };
  },

  async wait_for({ tabId, text, textGone, time, timeout }) {
    await ensureAttached(tabId);
    if (time) {
      await sleep(time * 1000);
      return { message: `Attente de ${time} s terminee.` };
    }
    const needle = text ?? textGone;
    if (!needle) throw new Error("Precise text, textGone ou time.");

    const deadline = Date.now() + (timeout ?? 15_000);
    while (Date.now() < deadline) {
      let present = false;
      try {
        present = await agentCall(tabId, "hasText", [needle]);
      } catch {
        present = false; // navigation en cours : on retente au tour suivant
      }
      if (text && present) return { message: `Texte "${text}" trouve dans la page.` };
      if (textGone && !present) return { message: `Texte "${textGone}" a disparu de la page.` };
      await sleep(300);
    }
    throw new Error(
      text
        ? `Le texte "${text}" n'est pas apparu avant le timeout.`
        : `Le texte "${textGone}" est toujours present apres le timeout.`,
    );
  },
};

// ---------------------------------------------------------- API pour la popup

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "status":
          sendResponse({
            connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
            config: await loadConfig(),
            tabs: await tabList(),
            sessions,
            assignments,
          });
          break;
        case "assign":
          // Le broker fait autorite : on lui transmet et il rediffusera l'etat a jour.
          send({ type: "event", event: "assign", tabId: msg.tabId, sessionId: msg.sessionId ?? null });
          sendResponse({ ok: true });
          break;
        case "share":
          await share(msg.tabId);
          sendResponse({ ok: true });
          break;
        case "unshare":
          await unshare(msg.tabId);
          sendResponse({ ok: true });
          break;
        case "setPrimary":
          if (shared.has(msg.tabId)) {
            primaryTabId = msg.tabId;
            await saveState();
            await pushTabs();
          }
          sendResponse({ ok: true });
          break;
        case "saveConfig":
          await chrome.storage.local.set({ port: Number(msg.port), token: msg.token ?? "" });
          if (ws) ws.close();
          backoffMs = 500;
          connect();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "Message inconnu" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    }
  })();
  return true; // reponse asynchrone
});

// ------------------------------------------------------------------ demarrage

chrome.runtime.onStartup.addListener(() => void restoreState().then(connect));
chrome.runtime.onInstalled.addListener(() => void restoreState().then(connect));

// Filet de securite : si le worker meurt malgre le keepalive (mise en veille de la
// machine, onglet ferme, navigateur sous pression memoire), l'alarme le reveille et
// il se rebranche sans attendre une action de l'utilisateur.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  backoffMs = 500;
  void restoreState().then(connect);
});

restoreState().then(connect);
