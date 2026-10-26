#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path, { basename } from "node:path";
import { BrokerClient } from "./broker-client.js";
import { DEFAULT_PORT } from "./protocol.js";

// stdout est reserve au protocole MCP : tout log part sur stderr.
const log = (msg) => process.stderr.write(`[chrome-bridge] ${msg}\n`);

const PORT = Number(process.env.CHROME_BRIDGE_PORT ?? DEFAULT_PORT);
const TOKEN = process.env.CHROME_BRIDGE_TOKEN ?? "";

// Deux conversations ouvertes dans le meme dossier doivent rester distinguables dans la
// popup : le pid du processus Claude Code parent les separe.
const LABEL = process.env.CHROME_BRIDGE_LABEL ?? `${basename(process.cwd())} #${process.ppid}`;

const bridge = new BrokerClient({ port: PORT, token: TOKEN, label: LABEL, log });
// Volontairement pas attendu : le serveur MCP doit repondre tout de suite, et chaque appel
// d'outil reverifie la connexion de toute facon.
bridge.start().catch((err) => log(err.message));

const NO_SHARED_TAB =
  "Aucun onglet n'est partage avec cette conversation. Clique sur l'icone de l'extension " +
  'dans le navigateur, puis sur "Partager cet onglet" sur la page a exposer. Si un onglet ' +
  "est partage mais invisible ici, c'est qu'une autre conversation se l'est reserve.";

/**
 * Choisit l'onglet cible : celui demande explicitement, sinon l'onglet primaire
 * (le dernier partage), sinon le premier de la liste.
 */
function resolveTabId(tabId) {
  const tabs = bridge.tabs;
  if (!tabs.length) throw new Error(NO_SHARED_TAB);
  if (tabId != null) {
    const found = tabs.find((t) => t.id === tabId);
    if (!found) {
      throw new Error(
        `L'onglet ${tabId} n'est pas partage. Onglets disponibles : ` +
          tabs.map((t) => `${t.id} (${t.title})`).join(", "),
      );
    }
    return found.id;
  }
  const primary = tabs.find((t) => t.primary);
  return (primary ?? tabs[0]).id;
}

const tabIdParam = {
  tabId: {
    type: "number",
    description:
      "Identifiant de l'onglet partage a cibler. Optionnel : par defaut l'onglet primaire.",
  },
};

const TOOLS = [
  {
    name: "browser_tabs",
    description:
      "Liste les onglets Chrome actuellement partages avec Claude Code, avec leur id, titre et URL. " +
      "A appeler en premier pour savoir sur quoi on travaille.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_claim_tab",
    description:
      "Reserve un onglet pour cette conversation : les autres conversations Claude Code ne " +
      "le voient plus et ne peuvent plus le piloter. A utiliser quand plusieurs sessions " +
      "travaillent en parallele sur le meme navigateur. La reservation est liberee " +
      "automatiquement a la fermeture de la conversation.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Identifiant de l'onglet a reserver." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "browser_release_tab",
    description: "Libere un onglet reserve par cette conversation et le rend aux autres.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Identifiant de l'onglet a liberer." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "browser_sessions",
    description:
      "Liste les conversations Claude Code connectees au pont et les onglets que chacune " +
      "s'est reserves. Utile pour comprendre pourquoi un onglet partage n'apparait pas.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_snapshot",
    description:
      "Capture textuelle structuree de la page (arbre d'accessibilite compact). Chaque element " +
      "interactif recoit une reference [ref=eN] a reutiliser dans browser_click, browser_type, etc. " +
      "Bien moins couteux qu'une capture d'ecran : c'est l'outil a privilegier pour lire la page.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabIdParam,
        maxNodes: {
          type: "number",
          description: "Nombre maximum d'elements a retourner (defaut 1200).",
        },
      },
    },
  },
  {
    name: "browser_click",
    description:
      "Clique sur un element identifie par sa reference issue du dernier browser_snapshot. " +
      "Utilise de vrais evenements souris envoyes par le navigateur (events trusted).",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: 'Reference de l\'element, ex. "e42".' },
        doubleClick: { type: "boolean", description: "Effectuer un double-clic." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Bouton de la souris (defaut left).",
        },
        ...tabIdParam,
      },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description:
      "Saisit du texte dans un champ identifie par sa reference. Le champ est focalise par un vrai " +
      "clic avant la saisie, ce qui declenche correctement les frameworks type React ou Vue.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: 'Reference du champ, ex. "e7".' },
        text: { type: "string", description: "Texte a saisir." },
        clear: { type: "boolean", description: "Vider le champ avant de saisir (defaut true)." },
        submit: { type: "boolean", description: "Appuyer sur Entree apres la saisie (defaut false)." },
        ...tabIdParam,
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_press_key",
    description:
      "Envoie une touche au clavier sur la page (ex. Enter, Escape, Tab, ArrowDown, PageDown, a).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Nom de touche, ex. "Enter" ou "Escape".' },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
          description: "Modificateurs a maintenir enfonces.",
        },
        ...tabIdParam,
      },
      required: ["key"],
    },
  },
  {
    name: "browser_hover",
    description: "Survole un element (utile pour ouvrir des menus deroulants au survol).",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, ...tabIdParam },
      required: ["ref"],
    },
  },
  {
    name: "browser_select_option",
    description: "Selectionne une ou plusieurs valeurs dans un element <select>.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        values: {
          type: "array",
          items: { type: "string" },
          description: "Valeurs ou libelles des options a selectionner.",
        },
        ...tabIdParam,
      },
      required: ["ref", "values"],
    },
  },
  {
    name: "browser_upload_file",
    description:
      "Envoie un ou plusieurs fichiers locaux (chemins absolus sur la machine du navigateur) dans un " +
      "<input type=file>. Sans ref ni selector, cible le premier <input type=file> de la page, meme " +
      "cache (cas des boutons Upload). Le formulaire/la page reagit comme apres un vrai choix de fichier.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: 'Chemins absolus, ex. ["C:\\Users\\moi\\plugin.jar"].',
        },
        ref: { type: "string", description: "Reference du champ issue du snapshot (optionnel)." },
        selector: { type: "string", description: "Selecteur CSS du champ (optionnel, defaut input[type=file])." },
        ...tabIdParam,
      },
      required: ["files"],
    },
  },
  {
    name: "browser_scroll",
    description:
      "Fait defiler la page, ou amene un element precis dans la zone visible si ref est fourni.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element vers lequel defiler (optionnel)." },
        deltaY: { type: "number", description: "Defilement vertical en pixels (defaut 600)." },
        deltaX: { type: "number", description: "Defilement horizontal en pixels." },
        ...tabIdParam,
      },
    },
  },
  {
    name: "browser_new_tab",
    description:
      "Ouvre une nouvelle page dans Chrome, la partage automatiquement et la reserve a cette " +
      "conversation. Aucun onglet deja partage n'est requis. S'ouvre en arriere-plan sauf si active=true.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL absolue http(s)." },
        active: { type: "boolean", description: "Mettre l'onglet au premier plan (defaut : false)." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_close_tab",
    description: "Ferme un onglet partage.",
    inputSchema: {
      type: "object",
      properties: { ...tabIdParam },
      required: ["tabId"],
    },
  },
  {
    name: "browser_navigate",
    description:
      "Navigue l'onglet partage vers une URL. Le partage est conserve apres la navigation.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL absolue." },
        ...tabIdParam,
      },
      required: ["url"],
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Evalue une expression JavaScript dans la page et retourne le resultat serialise. " +
      "Les promesses sont attendues. A utiliser quand snapshot ne suffit pas (etat interne, calculs).",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Expression JS, ex. \"document.querySelectorAll('.row').length\".",
        },
        ...tabIdParam,
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture d'ecran de l'onglet partage. Couteux en tokens : ne l'utiliser que pour juger du " +
      "rendu visuel, pas pour lire du contenu (utiliser browser_snapshot pour ca).",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean", description: "Capturer la page entiere (defaut false)." },
        ...tabIdParam,
      },
    },
  },
  {
    name: "browser_console",
    description:
      "Retourne les messages console captures depuis le partage de l'onglet (tampon circulaire).",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["all", "error", "warning"],
          description: "Filtre de niveau (defaut all).",
        },
        limit: { type: "number", description: "Nombre max de messages (defaut 50)." },
        ...tabIdParam,
      },
    },
  },
  {
    name: "browser_network",
    description:
      "Retourne les requetes reseau capturees depuis le partage de l'onglet (methode, URL, statut).",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Sous-chaine a chercher dans l'URL." },
        failedOnly: { type: "boolean", description: "Ne garder que les erreurs (statut >= 400)." },
        limit: { type: "number", description: "Nombre max de requetes (defaut 50)." },
        ...tabIdParam,
      },
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Attend qu'une condition soit remplie : apparition d'un texte, disparition d'un texte, " +
      "ou simple delai. Utile apres une action qui declenche un chargement.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Texte dont on attend l'apparition." },
        textGone: { type: "string", description: "Texte dont on attend la disparition." },
        time: { type: "number", description: "Delai fixe en secondes." },
        timeout: { type: "number", description: "Timeout en secondes (defaut 15)." },
        ...tabIdParam,
      },
    },
  },
];

const server = new Server(
  { name: "chrome-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: `Erreur : ${message}` }], isError: true };
}

function formatTabs(tabs) {
  if (!tabs.length) return NO_SHARED_TAB;
  return [
    `${tabs.length} onglet(s) visible(s) par cette conversation :`,
    ...tabs.map(
      (t) =>
        `- [${t.id}]${t.primary ? " (primaire)" : ""}${t.owner ? " (reserve ici)" : ""} ${t.title}\n  ${t.url}`,
    ),
  ].join("\n");
}

const handlers = {
  async browser_tabs() {
    // On interroge l'extension plutot que le cache local pour avoir titres et URL a jour.
    const tabs = await bridge.call("list_tabs");
    return textResult(formatTabs(tabs));
  },

  async browser_claim_tab(args) {
    const res = await bridge.call("claim_tab", { tabId: args.tabId });
    return textResult(
      `Onglet [${res.tabId}] "${res.title}" reserve pour cette conversation (${res.session}). ` +
        "Les autres conversations ne le voient plus.",
    );
  },

  async browser_release_tab(args) {
    const res = await bridge.call("release_tab", { tabId: args.tabId });
    return textResult(
      res.released
        ? `Onglet [${res.tabId}] libere : il redevient visible par toutes les conversations.`
        : `L'onglet [${res.tabId}] n'etait reserve par personne.`,
    );
  },

  async browser_sessions() {
    const sessions = await bridge.call("list_sessions");
    if (!sessions.length) return textResult("Aucune conversation connectee au pont.");
    return textResult(
      `${sessions.length} conversation(s) connectee(s) :\n` +
        sessions
          .map(
            (s) =>
              `- ${s.label} [${s.id}]${s.self ? " (celle-ci)" : ""}` +
              (s.tabs.length ? ` — onglets reserves : ${s.tabs.join(", ")}` : " — aucune reservation"),
          )
          .join("\n"),
    );
  },

  async browser_snapshot(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("snapshot", { tabId, maxNodes: args.maxNodes ?? 1200 });
    const header = [
      `# ${res.title}`,
      `URL : ${res.url}`,
      `Viewport : ${res.viewport.width}x${res.viewport.height}` +
        (res.viewport.scrollY ? ` (defilement Y : ${res.viewport.scrollY}px)` : ""),
      res.truncated ? `(arbre tronque a ${res.count} elements)` : "",
      "",
    ]
      .filter(Boolean)
      .join("\n");
    return textResult(header + res.tree);
  },

  async browser_click(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("click", {
      tabId,
      ref: args.ref,
      doubleClick: args.doubleClick ?? false,
      button: args.button ?? "left",
    });
    return textResult(`Clic effectue sur ${res.description}.`);
  },

  async browser_type(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("type", {
      tabId,
      ref: args.ref,
      text: args.text,
      clear: args.clear ?? true,
      submit: args.submit ?? false,
    });
    return textResult(
      `Texte saisi dans ${res.description}.` + (args.submit ? " Entree envoyee." : ""),
    );
  },

  async browser_press_key(args) {
    const tabId = resolveTabId(args.tabId);
    await bridge.call("press_key", { tabId, key: args.key, modifiers: args.modifiers ?? [] });
    return textResult(`Touche ${args.key} envoyee.`);
  },

  async browser_hover(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("hover", { tabId, ref: args.ref });
    return textResult(`Survol de ${res.description}.`);
  },

  async browser_select_option(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("select_option", { tabId, ref: args.ref, values: args.values });
    return textResult(`Selection appliquee sur ${res.description} : ${res.selected.join(", ")}.`);
  },

  async browser_upload_file(args) {
    const tabId = resolveTabId(args.tabId);
    const files = args.files ?? [];
    for (const f of files) {
      if (!path.isAbsolute(f) || !fs.existsSync(f)) throw new Error(`Fichier introuvable ou chemin non absolu : ${f}`);
    }
    const res = await bridge.call("upload_file", { tabId, ref: args.ref, selector: args.selector, files }, 60_000);
    return textResult(`${res.count} fichier(s) envoye(s) dans le champ.`);
  },

  async browser_scroll(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("scroll", {
      tabId,
      ref: args.ref ?? null,
      deltaX: args.deltaX ?? 0,
      deltaY: args.deltaY ?? (args.ref ? 0 : 600),
    });
    return textResult(`Defilement effectue. Position Y : ${res.scrollY}px.`);
  },

  async browser_new_tab(args) {
    const res = await bridge.call("new_tab", { url: args.url, active: args.active ?? false }, 60_000);
    try {
      await bridge.call("claim_tab", { tabId: res.tabId });
    } catch {
      /* deja reserve ou broker indisponible : l'onglet reste utilisable */
    }
    return textResult(`Onglet ${res.tabId} ouvert sur ${res.url} (titre : ${res.title}).`);
  },

  async browser_close_tab(args) {
    const tabId = resolveTabId(args.tabId);
    await bridge.call("close_tab", { tabId });
    return textResult(`Onglet ${tabId} ferme.`);
  },

  async browser_navigate(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("navigate", { tabId, url: args.url }, 45_000);
    return textResult(`Navigation vers ${res.url} terminee (titre : ${res.title}).`);
  },

  async browser_evaluate(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("evaluate", { tabId, expression: args.expression });
    return textResult(res.result);
  },

  async browser_screenshot(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("screenshot", { tabId, fullPage: args.fullPage ?? false }, 60_000);
    return {
      content: [
        { type: "image", data: res.data, mimeType: "image/png" },
        { type: "text", text: `Capture de ${res.url}` },
      ],
    };
  },

  async browser_console(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("console_messages", {
      tabId,
      level: args.level ?? "all",
      limit: args.limit ?? 50,
    });
    if (!res.messages.length) return textResult("Aucun message console capture.");
    return textResult(
      `${res.messages.length} message(s) console :\n` +
        res.messages.map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`).join("\n"),
    );
  },

  async browser_network(args) {
    const tabId = resolveTabId(args.tabId);
    const res = await bridge.call("network_requests", {
      tabId,
      filter: args.filter ?? "",
      failedOnly: args.failedOnly ?? false,
      limit: args.limit ?? 50,
    });
    if (!res.requests.length) return textResult("Aucune requete reseau capturee.");
    return textResult(
      `${res.requests.length} requete(s) :\n` +
        res.requests
          .map((r) => `${r.status ?? "..."} ${r.method} ${r.url}${r.error ? ` — ${r.error}` : ""}`)
          .join("\n"),
    );
  },

  async browser_wait_for(args) {
    const tabId = resolveTabId(args.tabId);
    const timeout = (args.timeout ?? 15) * 1000;
    const res = await bridge.call(
      "wait_for",
      {
        tabId,
        text: args.text ?? null,
        textGone: args.textGone ?? null,
        time: args.time ?? null,
        timeout,
      },
      timeout + 5000,
    );
    return textResult(res.message);
  },
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = handlers[name];
  if (!handler) return errorResult(`Outil inconnu : ${name}`);
  try {
    return await handler(args);
  } catch (err) {
    return errorResult(err?.message ?? String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("serveur MCP pret");
