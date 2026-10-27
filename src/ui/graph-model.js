// @ts-check
/**
 * Graph view — pure model layer. No DOM, no module state.
 *
 * Entries are projected into a node-link model: nodes are entries, people, tags
 * and teams; edges are membership (entry ↔ entity), summary→source links and
 * `follows` chain links. With entry nodes hidden, entities are linked directly
 * by weighted co-occurrence (shared entries).
 *
 * Everything here is a pure function of its arguments, so it is importable by
 * both the browser (raw ES module) and `node --test`.
 *
 * @typedef {{ id: string, date: string, type: string, title: string,
 *             people: string[], teams: string[], tags: string[],
 *             sources?: string[], follows?: string[],
 *             graphs?: string[], graph?: string, ghost?: boolean,
 *             chain?: { prev: string[], next: string[],
 *                       latest: { id: string, type: string, date: string },
 *                       resolvedBy?: string, status?: "open"|"resolved",
 *                       dangling?: string[] } }} GraphEntry
 *
 * @typedef {"person"|"tag"|"team"|"entry"} NodeKind
 * @typedef {"people"|"topics"|"entries"|"custom"} GraphMode
 *
 * @typedef {Object} GNode
 * @property {string} id namespaced: e:<entry-id> p:<person> t:<tag> m:<team>
 * @property {NodeKind} kind
 * @property {string} label
 * @property {string} etype entry type (entry nodes only; "" for entities)
 * @property {boolean} ghost entry from another graph shown in the private view for a cross-graph edge
 * @property {string} gmemb ghost's non-private memberships, comma-joined (ghost nodes only)
 * @property {number} deg
 * @property {number} r
 * @property {number} links edge count in the current projection (spring normalizer)
 * @property {string[]} entryIds backing entries (entities only)
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number|null} fx
 * @property {number|null} fy
 *
 * @typedef {{ a: string, b: string, weight: number, chain?: boolean }} GEdge
 *
 * @typedef {{ nodes: Map<string, GNode>, edges: GEdge[], memberships: string[][] }} GraphModel
 */

/** @type {{ kind: NodeKind, plural: string }[]} */
export const KINDS = [
  { kind: "person", plural: "people" },
  { kind: "tag", plural: "tags" },
  { kind: "team", plural: "teams" },
  { kind: "entry", plural: "entries" },
];

/** how many tag labels the topics view draws */
export const MAX_TOPIC_LABELS = 14;

/** A tag seen in a single entry is noise on the canvas — one dot per one-off
 * phrasing — so the view hides it whenever tags are drawn. This is a property
 * of tags, not of a mode: keying it to a mode name meant switching on another
 * kind silently changed which tags existed. The tag held by the tag filter is
 * always exempt (see projectGraph's keepTag). */
export const MIN_TAG_DEGREE = 2;

// ---------- small helpers ----------

/** @param {unknown} s */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** @param {string} s @param {number} [n] */
export function trunc(s, n = 18) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** An entry's graph memberships, tolerating the pre-multigraph shape.
 * @param {GraphEntry} e @returns {string[]} */
export function entryGraphs(e) {
  return e.graphs ?? [e.graph === "private" ? "default" : (e.graph ?? "default")];
}

/**
 * The store one level up: graphs as the nodes, shared membership as the links.
 *
 * An entry's home is the default graph and it reaches a named graph by
 * promotion or a rule, so the usual shape is a hub with spokes — but that is
 * data, not an assumption. A `move` leaves an entry in a named graph only
 * (counted as `outsideDefault`), and two named graphs link directly when an
 * entry sits in both.
 *
 * @param {GraphEntry[]} entries
 * @param {{ slug: string, name?: string }[]} registry
 * @returns {{
 *   nodes: { slug: string, name: string, count: number, outsideDefault: number }[],
 *   links: { a: string, b: string, shared: number }[],
 * }}
 */
export function graphRelations(entries, registry) {
  const known = new Set(registry.map((g) => g.slug));
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Map<string, number>} */
  const outside = new Map();
  /** @type {Map<string, number>} */
  const pairs = new Map();

  for (const e of entries) {
    const members = entryGraphs(e).filter((slug) => known.has(slug));
    const inDefault = members.includes("default");
    for (const slug of members) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
      if (!inDefault && slug !== "default") outside.set(slug, (outside.get(slug) ?? 0) + 1);
    }
    // every unordered pair the entry is a member of, keyed low|high so the
    // link is the same whichever order the memberships happen to be in
    const sorted = [...members].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  const nodes = registry
    .map((g) => ({
      slug: g.slug,
      name: g.name ?? g.slug,
      count: counts.get(g.slug) ?? 0,
      outsideDefault: outside.get(g.slug) ?? 0,
    }))
    .sort((a, b) =>
      a.slug === "default" ? -1 : b.slug === "default" ? 1 : b.count - a.count || a.name.localeCompare(b.name),
    );

  const links = [...pairs.entries()]
    .map(([key, shared]) => {
      const [a = "", b = ""] = key.split("|");
      return { a, b, shared };
    })
    .sort((x, y) => y.shared - x.shared || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  return { nodes, links };
}

/** @param {Exclude<GraphMode, "custom">} mode @returns {Record<NodeKind, boolean>} */
export function presetTypes(mode) {
  if (mode === "topics") return { person: false, tag: true, team: false, entry: false };
  if (mode === "entries") return { person: true, tag: false, team: false, entry: true };
  return { person: true, tag: false, team: true, entry: true };
}

/** The view a graph opens on. A shared graph is subject matter by
 * construction — it exists to explain topics to an audience — so it leads with
 * topics. The default graph is the personal record, where people are the way
 * in. An explicit choice still wins; this only sets the opening view.
 * @param {string} graph @returns {Exclude<GraphMode, "custom">} */
export function defaultMode(graph) {
  return graph === "default" ? "people" : "topics";
}

/** The mode a type selection amounts to. Toggling a kind chip can land back on
 * exactly a preset, and that has to read as the preset again — the mode carries
 * rules the chips don't (the topics tag-degree floor, the topics label cap), so
 * a selection stuck on "custom" renders a different graph from the identical
 * selection reached with the mode button.
 * @param {Record<NodeKind, boolean>} types @returns {GraphMode} */
export function modeForTypes(types) {
  for (const mode of /** @type {Exclude<GraphMode, "custom">[]} */ (["people", "topics", "entries"])) {
    const preset = presetTypes(mode);
    if (KINDS.every(({ kind }) => preset[kind] === types[kind])) return mode;
  }
  return "custom";
}

/** @param {GraphMode} mode */
export function modeLabel(mode) {
  return mode === "people" ? "people" : mode === "topics" ? "topics" : mode === "entries" ? "entries" : "custom";
}

/** hover/aria text for a node — shared by the tooltip and the a11y mirror list
 * @param {GNode} n */
export function nodeTip(n) {
  return n.kind === "entry"
    ? `${n.label} — ${n.etype}${n.ghost ? ` · ${n.gmemb} graph` : ""}`
    : `${n.label} — ${n.kind} — ${n.deg} entr${n.deg === 1 ? "y" : "ies"}`;
}

// ---------- graph model ----------

/**
 * @param {GraphEntry[]} entries
 * @returns {GraphModel}
 */
export function buildGraph(entries) {
  /** @type {Map<string, GNode>} */
  const nodes = new Map();
  /** @type {GEdge[]} */
  const edges = [];
  /** membership lists per entry (entity node ids) — feeds co-occurrence mode */
  /** @type {string[][]} */
  const memberships = [];
  const entryIds = new Set(entries.map((e) => e.id));

  /** @param {string} id @param {NodeKind} kind @param {string} label */
  const ensure = (id, kind, label) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, label, etype: "", ghost: false, gmemb: "", deg: 0, r: 4, links: 0, entryIds: [], x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null };
      nodes.set(id, n);
    }
    return n;
  };

  for (const e of entries) {
    const en = ensure(`e:${e.id}`, "entry", e.title);
    en.etype = e.type;
    // ghost = an entry from another graph surfaced only so a private chain edge
    // has a target; it contributes its entry node alone, no memberships/co-occurrence
    if (e.ghost) {
      en.ghost = true;
      en.gmemb = entryGraphs(e).filter((g) => g !== "default").join(", ") || "other";
      continue;
    }
    /** @type {string[]} */
    const members = [];
    /** @param {string[]} slugs @param {"p"|"t"|"m"} ns @param {NodeKind} kind */
    const link = (slugs, ns, kind) => {
      for (const s of slugs) {
        const node = ensure(`${ns}:${s}`, kind, s);
        node.deg++;
        node.entryIds.push(e.id);
        members.push(node.id);
        edges.push({ a: en.id, b: node.id, weight: 1 });
        en.deg++;
      }
    };
    link(e.people, "p", "person");
    link(e.tags, "t", "tag");
    link(e.teams, "m", "team");
    if (e.type === "summary" && e.sources) {
      for (const s of e.sources) {
        if (!entryIds.has(s)) continue; // dangling back-link
        edges.push({ a: en.id, b: `e:${s}`, weight: 1 });
        en.deg++;
      }
    }
    if (e.follows) {
      for (const f of e.follows) {
        if (!entryIds.has(f)) continue; // dangling chain link
        edges.push({ a: en.id, b: `e:${f}`, weight: 1, chain: true });
        en.deg++;
      }
    }
    memberships.push(members);
  }

  for (const n of nodes.values()) {
    n.r = n.kind === "entry" ? 4.5 : Math.min(20, Math.max(5, 5 + 2.6 * Math.sqrt(n.deg)));
  }
  return { nodes, edges, memberships };
}

/** The rules a node must clear that are independent of which kinds are switched
 * on — the entry-type filter and the topics tag-degree floor. Shared by the
 * projection and the toolbar counts so a chip can never promise a node the
 * canvas won't draw.
 * @param {GNode} n
 * @param {Record<string, boolean>} entryTypes
 * @param {{ minTagDegree?: number, keepTag?: string }} opts
 */
function nodeAllowed(n, entryTypes, opts) {
  return (
    (n.kind !== "entry" || entryTypes[n.etype] !== false) &&
    (n.kind !== "tag" || n.deg >= (opts.minTagDegree ?? 1) || n.label === opts.keepTag)
  );
}

/** How many nodes of each kind the canvas would draw if that kind were switched
 * on. Counting the raw model instead overstates the topics view by every tag
 * sitting below the degree floor.
 * @param {{ nodes: Map<string, GNode> }} model
 * @param {Record<string, boolean>} entryTypes
 * @param {{ minTagDegree?: number, keepTag?: string }} [opts]
 * @returns {Record<NodeKind, number>}
 */
export function visibleKindCounts(model, entryTypes, opts = {}) {
  /** @type {Record<NodeKind, number>} */
  const counts = { person: 0, tag: 0, team: 0, entry: 0 };
  for (const n of model.nodes.values()) if (nodeAllowed(n, entryTypes, opts)) counts[n.kind]++;
  return counts;
}

/**
 * Project the full model onto the enabled node kinds. Direct entity↔entity
 * co-occurrence links (weighted by shared entries) are always present — the
 * entries chip only adds/removes the entry-node layer and its membership edges.
 * @param {GraphModel} model
 * @param {Record<NodeKind, boolean>} types
 * @param {Record<string, boolean>} entryTypes
 * @param {{ minTagDegree?: number, keepTag?: string }} [opts]
 * @returns {{ nodes: GNode[], edges: GEdge[], hasCo: boolean }}
 */
export function projectGraph(model, types, entryTypes, opts = {}) {
  const visible = [...model.nodes.values()].filter((n) => types[n.kind] && nodeAllowed(n, entryTypes, opts));
  const ids = new Set(visible.map((n) => n.id));
  /** @type {Map<string, GEdge>} */
  const co = new Map();
  for (const members of model.memberships) {
    const vis = members.filter((id) => ids.has(id));
    for (let i = 0; i < vis.length; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        const a = /** @type {string} */ (vis[i]);
        const b = /** @type {string} */ (vis[j]);
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const edge = co.get(key);
        if (edge) edge.weight++;
        else co.set(key, { a, b, weight: 1 });
      }
    }
  }
  const edges = [...co.values()];
  if (types.entry) edges.push(...model.edges.filter((e) => ids.has(e.a) && ids.has(e.b)));
  return { nodes: visible, edges, hasCo: co.size > 0 };
}

/**
 * Which nodes carry a persistent label. People/entries views label every person;
 * the topics view labels only the strongest tags (labels there would otherwise
 * cover the whole canvas).
 * @param {GNode[]} ns @param {GraphMode} mode @param {number} [limit]
 * @returns {Set<string>}
 */
export function labelSet(ns, mode, limit = MAX_TOPIC_LABELS) {
  if (mode !== "topics") {
    return new Set(ns.filter((n) => n.kind === "person").map((n) => n.id));
  }
  return new Set(
    ns
      .filter((n) => n.kind === "tag")
      .sort((a, b) => b.deg - a.deg || b.links - a.links || a.label.localeCompare(b.label))
      .slice(0, limit)
      .map((n) => n.id),
  );
}
