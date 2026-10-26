/**
 * Agent injecte dans la page via Runtime.evaluate.
 *
 * Il expose window.__CCB__ : construction du snapshot d'accessibilite, resolution
 * des references [ref=eN] en coordonnees viewport absolues, et quelques helpers
 * que le service worker appelle avant d'envoyer de vrais evenements CDP.
 *
 * Le fichier entier est evalue comme une expression : il doit rester une IIFE.
 */
(function () {
  "use strict";

  if (window.__CCB__ && window.__CCB__.v === 2) return "ok";

  var MAX_NAME = 140;
  var refs = [];

  function clean(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function trunc(s, n) {
    n = n || MAX_NAME;
    return s.length > n ? s.slice(0, n) + "..." : s;
  }

  var INTERACTIVE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1,
    menuitemradio: 1, option: 1, switch: 1, combobox: 1, textbox: 1, searchbox: 1,
    slider: 1, spinbutton: 1, treeitem: 1, listbox: 1
  };

  var LANDMARK_TAGS = {
    MAIN: "main", NAV: "navigation", HEADER: "banner", FOOTER: "contentinfo",
    ASIDE: "complementary", FORM: "form", DIALOG: "dialog", TABLE: "table",
    SECTION: "section", ARTICLE: "article"
  };

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1,
    TITLE: 1, SVG: 1, PATH: 1, BR: 1
  };

  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    var tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SUMMARY") return "disclosure";
    if (tag === "IMG") return "img";
    if (tag === "IFRAME") return "iframe";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "file") return "file";
      if (t === "hidden") return "hidden";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (LANDMARK_TAGS[tag]) return LANDMARK_TAGS[tag];
    return "generic";
  }

  function labelFromLabels(el) {
    if (!el.labels || !el.labels.length) return "";
    return clean(el.labels[0].textContent || "");
  }

  /** Nom porte par un attribut, sans jamais retomber sur le texte des descendants. */
  function explicitName(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);

    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = labelledBy.split(/\s+/).map(function (id) {
        var target = el.ownerDocument.getElementById(id);
        return target ? target.textContent || "" : "";
      });
      var joined = clean(parts.join(" "));
      if (joined) return joined;
    }

    var title = el.getAttribute("title");
    return title ? clean(title) : "";
  }

  function accName(el) {
    var explicit = explicitName(el);
    if (explicit) return trunc(explicit);

    var tag = el.tagName;

    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      var lab = labelFromLabels(el);
      if (lab) return trunc(lab);
      var ph = el.getAttribute("placeholder");
      if (ph) return clean(ph);
      if (tag === "INPUT") {
        var type = (el.getAttribute("type") || "").toLowerCase();
        if ((type === "submit" || type === "button" || type === "reset") && el.value) {
          return clean(el.value);
        }
      }
      var name = el.getAttribute("name");
      if (name) return clean(name);
      return "";
    }

    if (tag === "IMG") return clean(el.getAttribute("alt") || "");
    if (tag === "IFRAME") return clean(el.getAttribute("name") || "");

    var text = clean(el.innerText || el.textContent || "");
    return trunc(text);
  }

  function isVisible(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.hasAttribute("hidden")) return false;
    var win = el.ownerDocument.defaultView;
    var cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    // Un conteneur a taille nulle peut contenir des enfants visibles (flex, absolute) :
    // on ne coupe la branche que si l'element est vide de surface ET d'enfants.
    if (r.width === 0 && r.height === 0 && el.children.length === 0) return false;
    return true;
  }

  function isInteractive(el) {
    var tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href");
    if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
    if (tag === "INPUT") return (el.getAttribute("type") || "").toLowerCase() !== "hidden";
    if (el.isContentEditable) return true;
    if (el.hasAttribute("onclick")) return true;
    var tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && tabindex !== "-1") return true;
    var role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES[role.split(/\s+/)[0]]) return true;
    return false;
  }

  function hrefShort(el) {
    var raw = el.getAttribute("href") || "";
    if (!raw || raw === "#") return "";
    try {
      var u = new URL(raw, el.ownerDocument.baseURI);
      var here = new URL(el.ownerDocument.baseURI);
      var short = u.origin === here.origin ? u.pathname + u.search + u.hash : u.href;
      return trunc(short, 90);
    } catch (e) {
      return trunc(raw, 90);
    }
  }

  /** Texte propre a l'element, hors texte porte par ses enfants elements. */
  function ownText(el) {
    var out = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return clean(out);
  }

  function describeEl(el, ref, structural) {
    var role = roleOf(el);
    // Un conteneur ne doit pas reciter le texte de ses enfants : ils sont deja listes dessous.
    var name = structural ? explicitName(el) : accName(el);
    var line = role;
    if (name) line += ' "' + name + '"';
    if (ref) line += " [ref=" + ref + "]";

    var extras = [];
    if (el.tagName === "A") {
      var h = hrefShort(el);
      if (h) extras.push(h);
    }
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        extras.push(el.checked ? "coche" : "non coche");
      } else if (el.value) {
        extras.push('value="' + trunc(String(el.value), 60) + '"');
      }
      if (el.required) extras.push("requis");
    }
    if (el.disabled) extras.push("desactive");
    var expanded = el.getAttribute("aria-expanded");
    if (expanded) extras.push("expanded=" + expanded);
    var checkedAttr = el.getAttribute("aria-checked");
    if (checkedAttr) extras.push("checked=" + checkedAttr);
    if (el.getAttribute("aria-selected") === "true") extras.push("selectionne");

    if (extras.length) line += " " + extras.join(" ");
    return line;
  }

  function shortDescribe(el) {
    var role = roleOf(el);
    var name = accName(el);
    return name ? role + ' "' + trunc(name, 60) + '"' : role + " <" + el.tagName.toLowerCase() + ">";
  }

  function snapshot(maxNodes) {
    maxNodes = maxNodes || 1200;
    refs = [];
    var lines = [];
    var state = { count: 0, truncated: false };

    function emit(depth, text) {
      lines.push(new Array(depth + 1).join("  ") + "- " + text);
    }

    function addRef(el) {
      refs.push(el);
      return "e" + (refs.length - 1);
    }

    function walk(el, depth) {
      if (state.count >= maxNodes) {
        state.truncated = true;
        return;
      }
      if (SKIP_TAGS[el.tagName]) return;
      if (!isVisible(el)) return;

      if (el.tagName === "IFRAME") {
        var doc = null;
        try {
          doc = el.contentDocument;
        } catch (e) {
          doc = null;
        }
        state.count++;
        if (doc && doc.body) {
          emit(depth, describeEl(el, addRef(el)) + " (meme origine)");
          walk(doc.body, depth + 1);
        } else {
          emit(depth, describeEl(el, null) + " (origine differente, contenu non inspectable)");
        }
        return;
      }

      var interactive = isInteractive(el);
      var role = roleOf(el);
      var landmark = LANDMARK_TAGS[el.tagName] && el.tagName !== "SECTION" && el.tagName !== "ARTICLE";
      var heading = role === "heading";
      var own = ownText(el);
      // Le texte d'un <label> est deja le nom accessible du champ qu'il designe.
      var redundantLabel = el.tagName === "LABEL" && el.control;
      var textLeaf = own && el.children.length === 0 && !redundantLabel;

      var emitted = false;
      if (interactive || heading || landmark) {
        state.count++;
        var actionable = interactive || heading;
        emit(depth, describeEl(el, actionable ? addRef(el) : null, !actionable));
        emitted = true;
      } else if (textLeaf) {
        state.count++;
        emit(depth, 'text "' + trunc(own) + '"');
        emitted = true;
      }

      // Le texte d'un bouton ou d'un lien est deja dans son nom accessible :
      // inutile de redescendre dedans, cela ne ferait que dupliquer.
      if (interactive && (role === "button" || role === "link" || role === "option")) return;

      var kids = el.children;
      for (var i = 0; i < kids.length; i++) {
        walk(kids[i], emitted ? depth + 1 : depth);
      }
    }

    if (document.body) walk(document.body, 0);

    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement.scrollHeight
      },
      count: state.count,
      truncated: state.truncated,
      tree: lines.join("\n")
    };
  }

  function lookup(ref) {
    var idx = parseInt(String(ref).replace(/^e/, ""), 10);
    if (isNaN(idx) || idx < 0 || idx >= refs.length) return null;
    var el = refs[idx];
    if (!el || !el.isConnected) return null;
    return el;
  }

  /** Rectangle en coordonnees viewport de la fenetre principale (traverse les iframes). */
  function absRect(el) {
    var r = el.getBoundingClientRect();
    var x = r.left;
    var y = r.top;
    var win = el.ownerDocument.defaultView;
    var guard = 0;
    while (win && win !== window.top && guard < 10) {
      var frame = null;
      try {
        frame = win.frameElement;
      } catch (e) {
        frame = null;
      }
      if (!frame) break;
      var fr = frame.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      win = frame.ownerDocument.defaultView;
      guard++;
    }
    return { x: x, y: y, width: r.width, height: r.height };
  }

  function missing(ref) {
    return {
      ok: false,
      error:
        'Reference "' + ref + '" introuvable ou element detache du DOM. ' +
        "Refais un browser_snapshot : les references changent a chaque capture."
    };
  }

  function rect(ref, scroll) {
    var el = lookup(ref);
    if (!el) return missing(ref);
    if (scroll !== false) {
      try {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } catch (e) {
        el.scrollIntoView();
      }
    }
    var r = absRect(el);
    var cx = r.x + r.width / 2;
    var cy = r.y + r.height / 2;
    var offScreen =
      r.width === 0 || r.height === 0 ||
      cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight;
    return {
      ok: true,
      x: Math.round(cx),
      y: Math.round(cy),
      width: Math.round(r.width),
      height: Math.round(r.height),
      offScreen: offScreen,
      description: shortDescribe(el)
    };
  }

  function focusRef(ref) {
    var el = lookup(ref);
    if (!el) return missing(ref);
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* element non focusable : le clic reel aura suffi */
    }
    return { ok: true, description: shortDescribe(el) };
  }

  function selectAll(ref) {
    var el = lookup(ref);
    if (!el) return missing(ref);
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      try {
        el.select();
        return { ok: true, hadValue: String(el.value || "").length > 0 };
      } catch (e) {
        return { ok: true, hadValue: String(el.value || "").length > 0 };
      }
    }
    if (el.isContentEditable) {
      var range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      var sel = el.ownerDocument.defaultView.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { ok: true, hadValue: clean(el.textContent).length > 0 };
    }
    return { ok: true, hadValue: false };
  }

  function setSelect(ref, values) {
    var el = lookup(ref);
    if (!el) return missing(ref);
    if (el.tagName !== "SELECT") {
      return { ok: false, error: shortDescribe(el) + " n'est pas un element <select>." };
    }
    var wanted = values.map(function (v) {
      return String(v).toLowerCase();
    });
    var chosen = [];
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      var match =
        wanted.indexOf(String(opt.value).toLowerCase()) !== -1 ||
        wanted.indexOf(clean(opt.textContent).toLowerCase()) !== -1;
      opt.selected = match;
      if (match) chosen.push(clean(opt.textContent) || opt.value);
    }
    if (!chosen.length) {
      var available = [];
      for (var j = 0; j < el.options.length && j < 30; j++) {
        available.push(clean(el.options[j].textContent) || el.options[j].value);
      }
      return {
        ok: false,
        error: "Aucune option ne correspond. Options disponibles : " + available.join(" | ")
      };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: chosen, description: shortDescribe(el) };
  }

  function scrollToRef(ref) {
    var el = lookup(ref);
    if (!el) return missing(ref);
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (e) {
      el.scrollIntoView();
    }
    return { ok: true, scrollY: Math.round(window.scrollY) };
  }

  function scrollBy(dx, dy) {
    window.scrollBy(dx || 0, dy || 0);
    return { ok: true, scrollY: Math.round(window.scrollY) };
  }

  /** Recherche insensible a la casse dans le texte rendu, iframes meme-origine incluses. */
  function hasText(needle) {
    var target = String(needle).toLowerCase();
    function inDoc(doc) {
      var body = doc.body;
      if (!body) return false;
      if ((body.innerText || "").toLowerCase().indexOf(target) !== -1) return true;
      var frames = doc.querySelectorAll("iframe");
      for (var i = 0; i < frames.length; i++) {
        var sub = null;
        try {
          sub = frames[i].contentDocument;
        } catch (e) {
          sub = null;
        }
        if (sub && inDoc(sub)) return true;
      }
      return false;
    }
    return inDoc(document);
  }

  window.__CCB__ = {
    v: 2,
    snapshot: snapshot,
    rect: rect,
    focusRef: focusRef,
    selectAll: selectAll,
    setSelect: setSelect,
    scrollToRef: scrollToRef,
    scrollBy: scrollBy,
    hasText: hasText,
    lookup: lookup
  };

  return "ok";
})();
