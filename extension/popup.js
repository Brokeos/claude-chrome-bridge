const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  error: $("error"),
  current: $("current"),
  shared: $("shared"),
  count: $("count"),
  empty: $("empty"),
  sessions: $("sessions"),
  sessionCount: $("sessionCount"),
  noSessions: $("noSessions"),
  port: $("port"),
  token: $("token"),
  save: $("save"),
  settings: $("settings"),
};

const ask = (message) => chrome.runtime.sendMessage(message);

function showError(text) {
  els.error.textContent = text;
  els.error.hidden = !text;
}

function tabRow({ title, url }) {
  const meta = document.createElement("div");
  meta.className = "meta";

  const t = document.createElement("span");
  t.className = "title";
  t.textContent = title || "(sans titre)";

  const u = document.createElement("span");
  u.className = "url";
  u.textContent = url || "";

  meta.append(t, u);
  return meta;
}

/**
 * Selecteur de conversation pour un onglet. Sans choix explicite, l'onglet reste visible
 * par toutes les conversations : c'est le comportement par defaut, le plus simple quand on
 * n'a qu'une session ouverte.
 */
function assignRow(tab, sessions, assignments, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "assign";

  const label = document.createElement("span");
  label.textContent = "Pilote par";

  const select = document.createElement("select");
  select.className = "select";

  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Toutes les conversations";
  select.append(all);

  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    select.append(opt);
  }

  const current = assignments[tab.id] ?? "";
  // Une reservation peut survivre quelques instants a la conversation qui l'a posee.
  if (current && !sessions.some((s) => s.id === current)) {
    const ghost = document.createElement("option");
    ghost.value = current;
    ghost.textContent = "conversation fermee";
    select.append(ghost);
  }
  select.value = current;

  select.addEventListener("change", () => onChange(select.value || null));
  wrap.append(label, select);
  return wrap;
}

async function render() {
  showError("");

  const status = await ask({ type: "status" });
  const connected = status.connected;
  const sessions = status.sessions ?? [];
  const assignments = status.assignments ?? {};

  els.status.textContent = connected ? "connecte" : "hors ligne";
  els.status.className = `status status--${connected ? "on" : "off"}`;

  els.port.value = status.config.port;
  els.token.value = status.config.token;
  if (!connected) els.settings.open = true;

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sharedIds = new Set(status.tabs.map((t) => t.id));

  // --- onglet courant ---
  els.current.replaceChildren();
  if (!active) {
    els.current.textContent = "Aucun onglet actif.";
  } else {
    els.current.append(tabRow(active));
    const internal = /^(chrome|edge|devtools|chrome-extension|about):/i.test(active.url ?? "");
    const isShared = sharedIds.has(active.id);

    const btn = document.createElement("button");
    btn.className = isShared ? "btn btn--danger" : "btn";
    btn.textContent = isShared ? "Retirer" : "Partager cet onglet";
    btn.disabled = internal;
    if (internal) btn.title = "Les pages internes du navigateur ne peuvent pas etre partagees.";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await ask({ type: isShared ? "unshare" : "share", tabId: active.id });
      if (res && res.ok === false) showError(res.error);
      render();
    });
    els.current.append(btn);
  }

  // --- onglets partages ---
  els.shared.replaceChildren();
  els.count.textContent = status.tabs.length ? `(${status.tabs.length})` : "";
  els.empty.hidden = status.tabs.length > 0;

  for (const tab of status.tabs) {
    const li = document.createElement("li");
    li.className = "tab";

    const row = document.createElement("div");
    row.className = "row";
    row.append(tabRow(tab));

    if (tab.primary) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "CIBLE";
      row.append(badge);
    } else {
      const makePrimary = document.createElement("button");
      makePrimary.className = "link";
      makePrimary.textContent = "cibler";
      makePrimary.title = "Faire de cet onglet la cible par defaut des outils Claude Code";
      makePrimary.addEventListener("click", async () => {
        await ask({ type: "setPrimary", tabId: tab.id });
        render();
      });
      row.append(makePrimary);
    }

    const remove = document.createElement("button");
    remove.className = "btn btn--danger";
    remove.textContent = "Retirer";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await ask({ type: "unshare", tabId: tab.id });
      render();
    });
    row.append(remove);
    li.append(row);

    li.append(
      assignRow(tab, sessions, assignments, async (sessionId) => {
        await ask({ type: "assign", tabId: tab.id, sessionId });
        // Le broker fait autorite : on lui laisse le temps de rediffuser l'etat.
        setTimeout(render, 300);
      }),
    );

    els.shared.append(li);
  }

  // --- conversations connectees ---
  els.sessions.replaceChildren();
  els.sessionCount.textContent = sessions.length ? `(${sessions.length})` : "";
  els.noSessions.hidden = sessions.length > 0;

  for (const session of sessions) {
    const owned = Object.entries(assignments).filter(([, id]) => id === session.id).length;
    const li = document.createElement("li");

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = session.label;
    const u = document.createElement("span");
    u.className = "url";
    u.textContent = owned
      ? `${owned} onglet(s) reserve(s)`
      : "voit tous les onglets non reserves";
    meta.append(t, u);

    li.append(meta);
    els.sessions.append(li);
  }
}

els.save.addEventListener("click", async () => {
  await ask({
    type: "saveConfig",
    port: Number(els.port.value) || 8777,
    token: els.token.value.trim(),
  });
  // Laisse a la reconnexion le temps d'aboutir avant de relire l'etat.
  setTimeout(render, 600);
});

render().catch((err) => showError(err.message));
