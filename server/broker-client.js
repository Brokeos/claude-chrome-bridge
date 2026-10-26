/**
 * Client du broker, utilise par le serveur MCP d'une conversation.
 *
 * Il masque entierement le cycle de vie du demon : la premiere session qui demarre lance
 * le broker en arriere-plan, les suivantes s'y branchent. Si le broker meurt (arret pour
 * inactivite, plantage, machine en veille), le client se rebranche et le relance au besoin.
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "./protocol.js";

const BROKER_PATH = fileURLToPath(new URL("./broker.js", import.meta.url));
const DEFAULT_TIMEOUT = 30_000;
const CONNECT_DEADLINE_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BrokerClient {
  constructor({ port = DEFAULT_PORT, token = "", label = "session", log = () => {} } = {}) {
    this.port = port;
    this.token = token;
    this.label = label;
    this.log = log;

    this.ws = null;
    this.sessionId = null;
    this.tabs = [];
    this.extensionConnected = false;
    this.pending = new Map();
    this.connecting = null;
    this.closed = false;
    this.reconnectDelay = 500;
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  async start() {
    await this.#ensure();
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* deja fermee */
    }
  }

  async call(method, params = {}, timeout = DEFAULT_TIMEOUT) {
    await this.#ensure();
    if (!this.connected) throw new Error("Le pont n'est pas joignable.");

    const id = `${this.sessionId ?? "s?"}-${++BrokerClient.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout (${timeout} ms) sur l'appel "${method}".`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type: "call", method, params }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  // ----------------------------------------------------------- connexion

  #ensure() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      let spawned = false;
      const deadline = Date.now() + CONNECT_DEADLINE_MS;
      let lastError = null;

      while (!this.closed && Date.now() < deadline) {
        try {
          await this.#attempt();
          this.reconnectDelay = 500;
          return;
        } catch (err) {
          lastError = err;
          // Personne n'ecoute : c'est a nous de lancer le demon, une seule fois.
          if (!spawned) {
            this.#spawnBroker();
            spawned = true;
          }
          await sleep(400);
        }
      }
      throw new Error(
        `Impossible de joindre le broker du pont sur 127.0.0.1:${this.port}` +
          (lastError ? ` (${lastError.message})` : "") +
          ". Verifie qu'aucun pare-feu ne bloque la boucle locale.",
      );
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  #attempt() {
    return new Promise((resolve, reject) => {
      const url =
        `ws://127.0.0.1:${this.port}/?role=mcp&label=${encodeURIComponent(this.label)}` +
        (this.token ? `&token=${encodeURIComponent(this.token)}` : "");
      // Le client ws n'envoie pas d'en-tete Origin : c'est precisement ce qui distingue
      // une session Claude Code d'une page web pour le controle d'acces du broker.
      const ws = new WebSocket(url);
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      ws.on("open", () => {
        if (settled) return;
        settled = true;
        this.ws = ws;
        resolve();
      });
      ws.on("error", fail);
      ws.on("message", (raw) => this.#onMessage(raw));
      ws.on("close", () => {
        fail(new Error("connexion fermee"));
        if (this.ws !== ws) return;
        this.ws = null;
        this.extensionConnected = false;
        this.#rejectAll(new Error("Le broker du pont s'est arrete. Nouvelle tentative en cours."));
        this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.#ensure().catch((err) => this.log(err.message));
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  #spawnBroker() {
    this.log("aucun broker en ecoute : demarrage d'un demon");
    try {
      const child = spawn(process.execPath, [BROKER_PATH], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CHROME_BRIDGE_PORT: String(this.port),
          CHROME_BRIDGE_TOKEN: this.token,
        },
      });
      // Le broker doit survivre a la fermeture de la conversation qui l'a lance.
      child.unref();
    } catch (err) {
      this.log(`demarrage du broker impossible : ${err.message}`);
    }
  }

  // ------------------------------------------------------------ messages

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "hello") {
      this.sessionId = msg.sessionId;
      this.extensionConnected = Boolean(msg.extension);
      if (msg.version !== PROTOCOL_VERSION) {
        // Un demon d'une version precedente est reste en vie : on lui demande la place
        // plutot que de laisser l'utilisateur diagnostiquer un port squatte.
        this.log(
          `broker en protocole v${msg.version}, attendu v${PROTOCOL_VERSION} : demande d'arret`,
        );
        try {
          this.ws.send(JSON.stringify({ type: "shutdown", reason: "version obsolete" }));
        } catch {
          /* deja mort */
        }
        this.ws?.close();
      }
      return;
    }

    if (msg.type === "event") {
      if (msg.event === "tabs") this.tabs = msg.tabs ?? [];
      else if (msg.event === "extension") this.extensionConnected = Boolean(msg.connected);
      return;
    }

    if (msg.type === "result") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(new Error(msg.error || "Erreur inconnue cote extension."));
    }
  }

  #rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

BrokerClient.seq = 0;
