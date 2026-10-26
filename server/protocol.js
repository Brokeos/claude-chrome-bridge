/**
 * Constantes partagees entre le broker, les clients MCP et (par convention) l'extension.
 *
 * Le pont est un broker unique : il possede le port, l'extension s'y connecte une fois,
 * et chaque session Claude Code s'y branche comme client. C'est ce qui permet a plusieurs
 * conversations de piloter le meme navigateur sans se disputer le port.
 */

export const DEFAULT_PORT = 8777;

/**
 * Incrementer a chaque changement incompatible du protocole broker <-> client MCP.
 * Un client qui trouve un broker d'une autre version lui demande de s'arreter et en
 * relance un a jour : sans ca, un demon oublie d'une version precedente squatterait le
 * port indefiniment.
 */
export const PROTOCOL_VERSION = 2;

/**
 * Un service worker MV3 est tue apres 30 s d'inactivite. Seul un message *recu* rearme
 * ce compteur cote Chromium : le ping protocolaire est traite par la couche reseau sans
 * reveiller le worker, et un ping sortant emis par l'extension ne compte pas. C'est donc
 * au broker d'envoyer un message applicatif, plus souvent que le seuil.
 */
export const KEEPALIVE_MS = 10_000;

/** Sonde des sockets a moitie ouvertes (un worker suspendu ne ferme pas toujours proprement). */
export const HEARTBEAT_MS = 15_000;

/** Si le worker meurt en plein appel, il se reconnecte en ~1 s : on garde l'appel au chaud. */
export const RESEND_GRACE_MS = 12_000;

/**
 * Rejouer un clic ou une frappe apres reconnexion pourrait le dupliquer : seules les
 * commandes sans effet de bord sont rejouables.
 */
export const REPLAYABLE = new Set([
  "list_tabs",
  "snapshot",
  "console_messages",
  "network_requests",
  "wait_for",
]);

/** Le broker s'arrete tout seul quand plus aucune session ne l'utilise. */
export const IDLE_SHUTDOWN_MS = 10 * 60_000;

/** Methodes traitees par le broker lui-meme, jamais transmises a l'extension. */
export const BROKER_METHODS = new Set(["list_tabs", "claim_tab", "release_tab", "list_sessions"]);
