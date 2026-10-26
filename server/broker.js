#!/usr/bin/env node
/**
 * Broker du pont : demon local unique qui possede le port.
 *
 * Deux familles de clients s'y connectent :
 *  - l'extension Chrome (une seule a la fois), qui execute les commandes ;
 *  - les serveurs MCP, un par conversation Claude Code, qui les emettent.
 *
 * Le broker route les appels, arbitre l'acces aux onglets (un onglet peut etre reserve a
 * une conversation) et survit a la mort du service worker MV3 en rejouant ce qui peut
 * l'etre. L'extension ne connait qu'un seul interlocuteur et ignore tout des sessions :
 * son protocole est strictement le meme qu'avant l'arrivee du broker.
 */
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  KEEPALIVE_MS,
  HEARTBEAT_MS,
  RESEND_GRACE_MS,
  REPLAYABLE,
  IDLE_SHUTDOWN_MS,
  BROKER_METHODS,
} from "./protocol.js";

const REPLACE_LOG_THROTTLE_MS = 10_000;

export class Broker {
  constructor({ port = DEFAULT_PORT, token = "", log = () => {}, idleShutdownMs = IDLE_SHUTDOWN_MS } = {}) {
    this.port = port;
    this.token = token;
    this.log = log;
    this.idleShutdownMs = idleShutdownMs;

    this.extension = null;
    /** sessionId -> { id, label, ws } */
    this.sessions = new Map();
    /** tabId -> sessionId */
    this.assignments = new Map();
    /** dernier etat d'onglets pousse par l'extension */
    this.tabs = [];
    /** brokerCallId -> { sessionId, clientId, method, payload } */
    this.pending = new Map();

    this.nextSession = 1;
    this.lastSessionAt = Date.now();
    this.lastReplaceLog = 0;
    this.onExit = () => process.exit(0);
  }

  start() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.port,
        verifyClient: (info, done) => this.#verify(info, done),
      });
      this.wss = wss;

      wss.on("listening", () => {
        this.log(`broker en ecoute sur ws://127.0.0.1:${this.port} (protocole v${PROTOCOL_VERSION})`);
        this.#startTimers();
        resolve(this);
      });

      // Un autre broker possede deja le port : il fait le travail, celui-ci n'a pas lieu
      // d'etre. On sort proprement plutot que de boucler et de laisser un zombie.
      wss.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          this.log(`port ${this.port} deja pris par un autre broker : arret`);
          try {
            wss.close();
          } catch {
            /* jamais demarre */
          }
          reject(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
          return;
        }
        this.log(`erreur serveur : ${err.message}`);
      });

      wss.on("connection", (ws, req) => this.#onConnection(ws, req));
    });
  }

  stop() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.keepaliveTimer);
    clearInterval(this.idleTimer);
    clearTimeout(this.resendTimer);
    try {
      this.wss?.close();
    } catch {
      /* deja ferme */
    }
    for (const client of this.wss?.clients ?? []) {
      try {
        client.terminate();
      } catch {
        /* deja morte */
      }
    }
  }

  // ------------------------------------------------------------------ timers

  #startTimers() {
    // Sonde les sockets a moitie ouvertes.
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.wss.clients) {
        if (client.isAlive === false) {
          this.log("socket sans reponse, fermeture");
          client.terminate();
          continue;
        }
        client.isAlive = false;
        try {
          client.ping();
        } catch {
          /* socket deja morte */
        }
      }
    }, HEARTBEAT_MS);

    // Message applicatif : c'est lui qui maintient le service worker MV3 eveille.
    this.keepaliveTimer = setInterval(() => {
      if (!this.extensionConnected) return;
      try {
        this.extension.send(JSON.stringify({ type: "keepalive" }));
      } catch {
        /* onclose fera le menage */
      }
    }, KEEPALIVE_MS);

    if (!this.idleShutdownMs) return;
    this.idleTimer = setInterval(() => {
      if (this.sessions.size) {
        this.lastSessionAt = Date.now();
        return;
      }
      if (Date.now() - this.lastSessionAt > this.idleShutdownMs) {
        this.log("plus aucune session depuis un moment : arret du broker");
        this.stop();
        this.onExit();
      }
    }, 60_000);
  }

  // ------------------------------------------------------------- connexions

  #verify(info, done) {
    const origin = info.origin ?? info.req.headers.origin ?? "";
    let params;
    try {
      params = new URL(info.req.url, "http://127.0.0.1").searchParams;
    } catch {
      return done(false, 400, "Bad request");
    }
    const role = params.get("role") ?? "extension";

    if (role === "mcp") {
      // Un navigateur envoie toujours un Origin. Exiger son absence empeche une page web
      // d'ouvrir une socket vers le port local en se faisant passer pour Claude Code.
      if (origin) {
        this.log(`connexion mcp refusee (origin=${origin})`);
        return done(false, 403, "Forbidden origin");
      }
    } else if (!origin.startsWith("chrome-extension://")) {
      this.log(`connexion refusee (origin=${origin || "vide"})`);
      return done(false, 403, "Forbidden origin");
    }

    if (this.token && params.get("token") !== this.token) {
      this.log("connexion refusee (jeton invalide)");
      return done(false, 401, "Bad token");
    }
    done(true);
  }

  #onConnection(ws, req) {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", (err) => this.log(`erreur socket : ${err.message}`));

    const params = new URL(req.url, "http://127.0.0.1").searchParams;
    if ((params.get("role") ?? "extension") === "mcp") {
      this.#attachSession(ws, params.get("label") || "session");
    } else {
      this.#attachExtension(ws, req.headers.origin ?? "?");
    }
  }

  #attachExtension(ws, origin) {
    if (this.extensionConnected) {
      // Une seule extension a la fois : la nouvelle remplace l'ancienne. Log throttle,
      // un service worker qui redemarre en boucle ne doit pas noyer stderr.
      const now = Date.now();
      if (now - this.lastReplaceLog > REPLACE_LOG_THROTTLE_MS) {
        this.lastReplaceLog = now;
        this.log(`connexion extension remplacee (${origin})`);
      }
      this.extension.close(4000, "replaced");
    } else {
      this.log(`extension connectee (${origin})`);
    }
    this.extension = ws;

    ws.on("message", (raw) => this.#onExtensionMessage(raw));
    ws.on("close", () => {
      if (this.extension !== ws) return; // socket deja remplacee : rien a nettoyer
      this.extension = null;
      this.tabs = [];
      this.log("extension deconnectee");
      this.#broadcastExtensionState();
      this.#awaitReconnect();
    });

    this.#pushSessions();
    this.#broadcastExtensionState();
  }

  #attachSession(ws, label) {
    const id = `s${this.nextSession++}`;
    const session = { id, label, ws };
    this.sessions.set(id, session);
    this.lastSessionAt = Date.now();
    this.log(`session connectee : ${id} (${label}) — ${this.sessions.size} active(s)`);

    ws.send(
      JSON.stringify({
        type: "hello",
        version: PROTOCOL_VERSION,
        sessionId: id,
        pid: process.pid,
        extension: this.extensionConnected,
      }),
    );
    this.#pushTabs(session);
    this.#pushSessions();

    ws.on("message", (raw) => this.#onSessionMessage(session, raw));
    ws.on("close", () => {
      this.sessions.delete(id);
      this.lastSessionAt = Date.now();
      // Une conversation fermee ne doit pas garder d'onglet en otage.
      for (const [tabId, owner] of [...this.assignments]) {
        if (owner === id) this.assignments.delete(tabId);
      }
      for (const [callId, entry] of [...this.pending]) {
        if (entry.sessionId === id) this.pending.delete(callId);
      }
      this.log(`session ${id} (${label}) deconnectee — ${this.sessions.size} active(s)`);
      this.#pushAllTabs();
      this.#pushSessions();
    });
  }

  get extensionConnected() {
    return Boolean(this.extension && this.extension.readyState === this.extension.OPEN);
  }

  // -------------------------------------------------------------- messages

  #onExtensionMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.log("message illisible recu de l'extension");
      return;
    }

    if (msg.type === "event") {
      if (msg.event === "tabs") {
        this.tabs = msg.tabs ?? [];
        // Un onglet ferme ou retire du partage libere sa reservation.
        const live = new Set(this.tabs.map((t) => t.id));
        for (const tabId of [...this.assignments.keys()]) {
          if (!live.has(tabId)) this.assignments.delete(tabId);
        }
        this.#pushAllTabs();
        this.#pushSessions();
      } else if (msg.event === "assign") {
        // Reservation pilotee depuis la popup de l'extension.
        this.#assign(msg.tabId, msg.sessionId ?? null);
      }
      return;
    }

    if (msg.type === "result") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      this.#replyTo(entry, { ok: msg.ok, data: msg.data, error: msg.error });
    }
  }

  #onSessionMessage(session, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.log(`message illisible recu de ${session.id}`);
      return;
    }

    // Un client qui detecte une version de protocole differente demande la place.
    if (msg.type === "shutdown") {
      this.log(`arret demande par ${session.id} (${msg.reason ?? "sans raison"})`);
      this.stop();
      this.onExit();
      return;
    }

    if (msg.type !== "call") return;

    try {
      if (BROKER_METHODS.has(msg.method)) {
        const data = this.#handleLocal(session, msg.method, msg.params ?? {});
        this.#send(session.ws, { id: msg.id, type: "result", ok: true, data });
        return;
      }
      this.#forward(session, msg);
    } catch (err) {
      this.#send(session.ws, {
        id: msg.id,
        type: "result",
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  }

  // ------------------------------------------------- methodes du broker

  #handleLocal(session, method, params) {
    switch (method) {
      case "list_tabs":
        return this.#visibleTabs(session.id);

      case "claim_tab": {
        const tab = this.tabs.find((t) => t.id === params.tabId);
        if (!tab) throw new Error(`L'onglet ${params.tabId} n'est pas partage.`);
        const owner = this.assignments.get(params.tabId);
        if (owner && owner !== session.id) {
          throw new Error(
            `L'onglet ${params.tabId} est deja reserve par ${this.#label(owner)}. ` +
              "Cette conversation doit le liberer, ou change de reservation depuis la popup.",
          );
        }
        this.#assign(params.tabId, session.id);
        return { tabId: params.tabId, title: tab.title, session: session.label };
      }

      case "release_tab": {
        const owner = this.assignments.get(params.tabId);
        if (!owner) return { tabId: params.tabId, released: false };
        if (owner !== session.id) {
          throw new Error(
            `L'onglet ${params.tabId} est reserve par ${this.#label(owner)} : ` +
              "cette conversation ne peut pas le liberer.",
          );
        }
        this.#assign(params.tabId, null);
        return { tabId: params.tabId, released: true };
      }

      case "list_sessions":
        return [...this.sessions.values()].map((s) => ({
          id: s.id,
          label: s.label,
          self: s.id === session.id,
          tabs: [...this.assignments].filter(([, o]) => o === s.id).map(([t]) => t),
        }));

      default:
        throw new Error(`Methode broker inconnue : ${method}`);
    }
  }

  #assign(tabId, sessionId) {
    if (sessionId) this.assignments.set(tabId, sessionId);
    else this.assignments.delete(tabId);
    this.#pushAllTabs();
    this.#pushSessions();
  }

  #label(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? `${s.label} (${s.id})` : `une autre conversation (${sessionId})`;
  }

  // ------------------------------------------------------- transmission

  #forward(session, msg) {
    if (!this.extensionConnected) {
      throw new Error(
        "L'extension du navigateur n'est pas connectee. Verifie qu'elle est chargee, puis " +
          `ouvre sa popup et controle que le port configure est bien ${this.port}.`,
      );
    }

    const tabId = msg.params?.tabId;
    if (tabId != null) {
      const owner = this.assignments.get(tabId);
      if (owner && owner !== session.id) {
        throw new Error(`L'onglet ${tabId} est reserve par ${this.#label(owner)}.`);
      }
    }

    const brokerId = randomUUID();
    const payload = JSON.stringify({
      id: brokerId,
      type: "call",
      method: msg.method,
      params: msg.params ?? {},
    });
    this.pending.set(brokerId, {
      sessionId: session.id,
      clientId: msg.id,
      method: msg.method,
      payload,
    });
    this.extension.send(payload, (err) => {
      if (!err) return;
      this.pending.delete(brokerId);
      this.#send(session.ws, {
        id: msg.id,
        type: "result",
        ok: false,
        error: `Envoi impossible vers l'extension : ${err.message}`,
      });
    });
  }

  #replyTo(entry, result) {
    const session = this.sessions.get(entry.sessionId);
    if (!session) return; // la conversation a ferme entre-temps
    this.#send(session.ws, {
      id: entry.clientId,
      type: "result",
      ok: result.ok,
      data: result.data,
      error: result.error,
    });
  }

  #send(ws, obj) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket morte : le close handler nettoiera */
    }
  }

  /**
   * Le service worker vient de mourir avec des appels en vol. Plutot que d'echouer tout
   * de suite, on attend sa reconnexion (~1 s) et on rejoue ce qui peut l'etre sans risque.
   */
  #awaitReconnect() {
    if (!this.pending.size) return;
    clearTimeout(this.resendTimer);
    const deadline = Date.now() + RESEND_GRACE_MS;

    const tick = () => {
      if (!this.pending.size) return;

      if (this.extensionConnected) {
        let replayed = 0;
        for (const [id, entry] of [...this.pending]) {
          if (!REPLAYABLE.has(entry.method)) {
            this.pending.delete(id);
            this.#replyTo(entry, {
              ok: false,
              error:
                `Le service worker de l'extension est mort pendant "${entry.method}". ` +
                "L'action a peut-etre ete appliquee : verifie l'etat de la page avant de reessayer.",
            });
            continue;
          }
          try {
            this.extension.send(entry.payload);
            replayed++;
          } catch {
            this.resendTimer = setTimeout(tick, 300);
            return;
          }
        }
        if (replayed) this.log(`${replayed} appel(s) rejoue(s) apres reconnexion`);
        return;
      }

      if (Date.now() >= deadline) {
        for (const [id, entry] of [...this.pending]) {
          this.pending.delete(id);
          this.#replyTo(entry, {
            ok: false,
            error:
              `Extension deconnectee : aucune reconnexion apres ${Math.round(RESEND_GRACE_MS / 1000)} s. ` +
              "Ouvre la page des extensions du navigateur et recharge Claude Code Bridge.",
          });
        }
        return;
      }
      this.resendTimer = setTimeout(tick, 300);
    };

    this.resendTimer = setTimeout(tick, 300);
  }

  // ------------------------------------------------------------ diffusion

  /**
   * Vue des onglets propre a une session : les onglets reserves ailleurs sont invisibles,
   * et la cible par defaut est l'onglet reserve par cette session s'il y en a un.
   */
  #visibleTabs(sessionId) {
    const mine = [];
    for (const tab of this.tabs) {
      const owner = this.assignments.get(tab.id) ?? null;
      if (owner && owner !== sessionId) continue;
      mine.push({ ...tab, owner });
    }
    const target =
      mine.find((t) => t.owner === sessionId) ?? mine.find((t) => t.primary) ?? mine[0] ?? null;
    return mine.map((t) => ({ ...t, primary: target ? t.id === target.id : false }));
  }

  #pushTabs(session) {
    this.#send(session.ws, {
      type: "event",
      event: "tabs",
      tabs: this.#visibleTabs(session.id),
    });
  }

  #pushAllTabs() {
    for (const session of this.sessions.values()) this.#pushTabs(session);
  }

  #broadcastExtensionState() {
    for (const session of this.sessions.values()) {
      this.#send(session.ws, {
        type: "event",
        event: "extension",
        connected: this.extensionConnected,
      });
    }
  }

  /** Informe l'extension des conversations en cours, pour l'affichage dans la popup. */
  #pushSessions() {
    if (!this.extensionConnected) return;
    this.#send(this.extension, {
      type: "event",
      event: "sessions",
      sessions: [...this.sessions.values()].map((s) => ({ id: s.id, label: s.label })),
      assignments: Object.fromEntries(this.assignments),
    });
  }
}

// ------------------------------------------------------------ demarrage CLI

// pathToFileURL, et pas une concatenation "file://" : sous Windows argv[1] est un chemin
// a antislashs avec une lettre de lecteur, qui ne donne pas la meme URL que import.meta.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const log = (msg) => process.stderr.write(`[chrome-bridge/broker] ${msg}\n`);
  const broker = new Broker({
    port: Number(process.env.CHROME_BRIDGE_PORT ?? DEFAULT_PORT),
    token: process.env.CHROME_BRIDGE_TOKEN ?? "",
    log,
  });
  broker.start().catch((err) => {
    if (err.code === "EADDRINUSE") process.exit(0);
    log(`demarrage impossible : ${err.message}`);
    process.exit(1);
  });
}
