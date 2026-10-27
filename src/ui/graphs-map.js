/**
 * The graph registry drawn as a map: graphs are the nodes, shared membership
 * the links. It sits at the top of the Manage Graphs screen as the high view
 * of the same structure the entries graph shows one level down.
 *
 * Layout is radial rather than force-directed on purpose. The store is a hub
 * with spokes by construction — capture lands in the default graph and reaches
 * a named graph by promotion or a rule — so a deterministic ring says that,
 * and stays legible at the two or three graphs a registry usually holds, where
 * a force simulation has too little structure to settle into anything.
 */

import { esc, graphRelations } from "./graph-model.js";

const VB_W = 980;
// tall enough for a satellite at the bottom of the ring plus its label:
// CY + RING*RING_SQUASH + R_SAT_MAX + label
const VB_H = 440;
const CX = VB_W / 2;
const CY = VB_H / 2;
/** how far the named graphs sit from the hub */
const RING = 215;
const R_HUB = 54;
const R_SAT_MIN = 28;
const R_SAT_MAX = 48;
/** The ring is squashed vertically — a disc read at an angle, which keeps a
 * wide banner from needing the height a true circle would. It cannot squash
 * much further: the graphs at the top and bottom of the ring need to clear the
 * hub's disc and their own labels, so RING * RING_SQUASH stays above
 * R_HUB + R_SAT_MAX + the label line. */
const RING_SQUASH = 0.68;
/** radians per second — one turn takes well over two minutes, enough to read
 * as alive without inviting the eye to follow it */
export const SPIN_RATE = 0.045;
/** seconds for a mote to travel the hub→satellite run */
export const MOTE_PERIOD = 2.6;

/** Where a graph sits on the ring at time `t` (seconds since mount).
 * @param {number} angle the graph's fixed slot
 * @param {number} t
 * @returns {{ x: number, y: number }} */
export function ringPos(angle, t) {
  const a = angle + t * SPIN_RATE;
  return { x: CX + RING * Math.cos(a), y: CY + RING * Math.sin(a) * RING_SQUASH };
}

/** How far along its run a mote is, in [0, 1). Two motes per spoke sit half a
 * period apart, and each spoke is offset by its angle so the field does not
 * pulse in unison.
 * @param {number} t @param {number} i @param {number} angle */
export function motePhase(t, i, angle) {
  return (t / MOTE_PERIOD + i * 0.5 + angle) % 1;
}

/** A mote's position and opacity along the hub→satellite run. Eased so it
 * leaves and arrives rather than tracking at constant speed, and faded at both
 * ends so it appears to depart and land rather than blink.
 * @param {number} toX @param {number} toY @param {number} phase */
export function moteAt(toX, toY, phase) {
  const eased = phase * phase * (3 - 2 * phase);
  return {
    x: CX + (toX - CX) * eased,
    y: CY + (toY - CY) * eased,
    opacity: Math.sin(phase * Math.PI) * 0.9,
  };
}

/** @typedef {{ slug: string, name: string, count: number, outsideDefault: number }} GraphNode */
/** A graph's place on the ring. `angle` is its fixed slot; `x`/`y` are written
 * each frame once the ring has turned.
 * @typedef {{ node: GraphNode, angle: number, r: number, x?: number, y?: number }} Placed */

/** Disc radius for a named graph. Square-rooted so a graph 60x smaller than
 * another is still a readable disc rather than a dot.
 * @param {number} count @param {number} max */
function satRadius(count, max) {
  if (max <= 0) return R_SAT_MIN;
  return R_SAT_MIN + (R_SAT_MAX - R_SAT_MIN) * Math.sqrt(Math.min(count, max) / max);
}

/** @param {number} shared @param {number} max */
function linkWidth(shared, max) {
  if (max <= 0) return 1.5;
  return 1.5 + 5 * Math.sqrt(shared / max);
}

/**
 * Draw the map into `host`.
 *
 * @param {HTMLElement} host
 * @param {import("./graph-model.js").GraphEntry[]} entries
 * @param {{ slug: string, name?: string }[]} registry
 * @returns {() => void} stop — cancels the animation loop
 */
export function renderGraphMap(host, entries, registry) {
  const { nodes, links } = graphRelations(entries, registry);
  const hub = nodes.find((n) => n.slug === "default");
  const sats = nodes.filter((n) => n.slug !== "default");

  if (!hub || sats.length === 0) {
    host.innerHTML = `
      <div class="gmap gmap-empty">
        <p>the <b>default</b> graph is the whole store so far — create a named graph and this map shows what it shares with it</p>
      </div>`;
    return () => {};
  }

  const maxSat = Math.max(...sats.map((n) => n.count), 1);
  const maxShared = Math.max(...links.map((l) => l.shared), 1);

  /** angles start due east so a single satellite sits beside the hub rather
   * than above its label; evenly spaced from there
   * @type {Map<string, Placed>} */
  const placed = new Map();
  sats.forEach((node, i) => {
    placed.set(node.slug, {
      node,
      angle: (i * 2 * Math.PI) / sats.length,
      r: satRadius(node.count, maxSat),
    });
  });

  const spokes = links.filter((l) => l.a === "default" || l.b === "default");
  const chords = links.filter((l) => l.a !== "default" && l.b !== "default");

  host.innerHTML = `
    <figure class="gmap">
      <svg viewBox="0 0 ${VB_W} ${VB_H}" role="img"
           aria-label="map of the graph registry: ${esc(String(sats.length))} named graph${sats.length === 1 ? "" : "s"} sharing entries with the default graph">
        <defs>
          <radialGradient id="gmap-hub-glow">
            <stop offset="0%" stop-color="var(--cat-team)" stop-opacity="0.30"/>
            <stop offset="100%" stop-color="var(--cat-team)" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g class="gmap-links">
          ${spokes.map((l) => spokeSvg(l, placed, maxShared)).join("")}
          ${chords.map((l) => chordSvg(l, placed, maxShared)).join("")}
        </g>
        <g class="gmap-nodes">
          ${hubSvg(hub)}
          ${sats.map((n) => satSvg(/** @type {NonNullable<ReturnType<typeof placed.get>>} */ (placed.get(n.slug)))).join("")}
        </g>
      </svg>
      <figcaption class="gmap-cap">
        every entry's home is <b>default</b>; a line is the entries two graphs share
      </figcaption>
    </figure>`;

  return animate(host, placed, spokes);
}

/** @param {GraphNode} hub */
function hubSvg(hub) {
  return `
    <g class="gnode gnode-hub" data-slug="default" transform="translate(${CX} ${CY})" tabindex="0" role="link"
       aria-label="default graph, ${hub.count} entries">
      <circle class="gnode-glow" r="${R_HUB * 2.4}" fill="url(#gmap-hub-glow)"/>
      <circle class="gnode-disc" r="${R_HUB}"/>
      <text class="gnode-n" y="-1">${hub.count}</text>
      <text class="gnode-label gnode-label-in" y="17">default</text>
    </g>`;
}

/** @param {Placed} p */
function satSvg(p) {
  const { node, r } = p;
  const moved = node.outsideDefault > 0 ? ` · ${node.outsideDefault} only here` : "";
  return `
    <g class="gnode gnode-sat" data-slug="${esc(node.slug)}" tabindex="0" role="link"
       aria-label="${esc(node.name)} graph, ${node.count} entries${esc(moved)}">
      <circle class="gnode-disc" r="${r}"/>
      <text class="gnode-n" y="5">${node.count}</text>
      <text class="gnode-label" y="${r + 22}">${esc(node.name)}</text>
    </g>`;
}

/** @param {{ a: string, b: string, shared: number }} l
 * @param {Map<string, Placed>} placed
 * @param {number} maxShared */
function spokeSvg(l, placed, maxShared) {
  const slug = l.a === "default" ? l.b : l.a;
  if (!placed.has(slug)) return "";
  return `
    <g class="gmap-spoke" data-slug="${esc(slug)}">
      <line class="gmap-line" stroke-width="${linkWidth(l.shared, maxShared).toFixed(2)}"/>
      <circle class="gmap-mote" r="3.2"/>
      <circle class="gmap-mote gmap-mote-2" r="2.4"/>
      <text class="gmap-shared">${l.shared}</text>
    </g>`;
}

/** @param {{ a: string, b: string, shared: number }} l
 * @param {Map<string, Placed>} placed
 * @param {number} maxShared */
function chordSvg(l, placed, maxShared) {
  if (!placed.has(l.a) || !placed.has(l.b)) return "";
  return `
    <g class="gmap-chord" data-a="${esc(l.a)}" data-b="${esc(l.b)}">
      <path class="gmap-line" fill="none" stroke-width="${linkWidth(l.shared, maxShared).toFixed(2)}"/>
      <text class="gmap-shared">${l.shared}</text>
    </g>`;
}

/**
 * Position everything each frame. The ring turns slowly — enough to read as
 * alive, not enough to chase with the eye — and motes drift from the hub out
 * along each spoke, the direction entries actually travel.
 *
 * @param {HTMLElement} host
 * @param {Map<string, Placed>} placed
 * @param {{ a: string, b: string, shared: number }[]} spokes
 */
function animate(host, placed, spokes) {
  const svg = host.querySelector("svg");
  if (!svg) return () => {};
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  let raf = 0;
  const t0 = performance.now();

  /** @param {number} now */
  const frame = (now) => {
    // the view is replaced wholesale on re-render; stop rather than animate
    // a detached tree forever
    if (!host.isConnected) return;
    const t = still ? 0 : (now - t0) / 1000;

    for (const [slug, p] of placed) {
      const { x, y } = ringPos(p.angle, t);
      const g = svg.querySelector(`.gnode-sat[data-slug="${CSS.escape(slug)}"]`);
      g?.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      p.x = x;
      p.y = y;
    }

    for (const l of spokes) {
      const slug = l.a === "default" ? l.b : l.a;
      const p = placed.get(slug);
      const g = svg.querySelector(`.gmap-spoke[data-slug="${CSS.escape(slug)}"]`);
      if (!p || !g || p.x === undefined || p.y === undefined) continue;
      const line = g.querySelector(".gmap-line");
      line?.setAttribute("x1", String(CX));
      line?.setAttribute("y1", String(CY));
      line?.setAttribute("x2", p.x.toFixed(2));
      line?.setAttribute("y2", p.y.toFixed(2));

      const { x: ex, y: ey, angle } = p;
      const label = g.querySelector(".gmap-shared");
      label?.setAttribute("x", (CX + (ex - CX) * 0.52).toFixed(2));
      label?.setAttribute("y", (CY + (ey - CY) * 0.52 - 7).toFixed(2));

      g.querySelectorAll(".gmap-mote").forEach((mote, i) => {
        const { x: mx, y: my, opacity } = moteAt(ex, ey, motePhase(t, i, angle));
        mote.setAttribute("cx", mx.toFixed(2));
        mote.setAttribute("cy", my.toFixed(2));
        mote.setAttribute("opacity", still ? "0" : opacity.toFixed(2));
      });
    }

    for (const g of svg.querySelectorAll(".gmap-chord")) {
      const pa = placed.get(g.getAttribute("data-a") ?? "");
      const pb = placed.get(g.getAttribute("data-b") ?? "");
      const ax = pa?.x, ay = pa?.y, bxp = pb?.x, byp = pb?.y;
      if (ax === undefined || ay === undefined || bxp === undefined || byp === undefined) continue;
      // Bow the chord perpendicular to itself, not away from the hub: two
      // graphs on opposite sides of the ring have their midpoint ON the hub,
      // and a radial bow would collapse the curve into a straight line hidden
      // under their two spokes.
      const mx = (ax + bxp) / 2;
      const my = (ay + byp) / 2;
      const len = Math.hypot(bxp - ax, byp - ay) || 1;
      let nx = -(byp - ay) / len;
      let ny = (bxp - ax) / len;
      // push it to whichever side is away from the hub, so it clears the discs
      if (nx * (mx - CX) + ny * (my - CY) < 0) {
        nx = -nx;
        ny = -ny;
      }
      const bow = len * 0.22;
      const bx = mx + nx * bow;
      const by = my + ny * bow;
      g.querySelector(".gmap-line")?.setAttribute("d", `M${ax.toFixed(1)} ${ay.toFixed(1)} Q${bx.toFixed(1)} ${by.toFixed(1)} ${bxp.toFixed(1)} ${byp.toFixed(1)}`);
      const label = g.querySelector(".gmap-shared");
      label?.setAttribute("x", bx.toFixed(1));
      label?.setAttribute("y", by.toFixed(1));
    }

    if (!still) raf = requestAnimationFrame(frame);
  };

  frame(t0);

  // a hover or focus anywhere on a node lights its spoke too
  host.addEventListener("pointerover", onPoint);
  host.addEventListener("focusin", onPoint);
  host.addEventListener("pointerout", offPoint);
  host.addEventListener("focusout", offPoint);
  host.addEventListener("click", onActivate);
  host.addEventListener("keydown", onKey);

  /** @param {Event} ev */
  function onPoint(ev) {
    const node = ev.target instanceof Element ? ev.target.closest(".gnode") : null;
    const slug = node?.getAttribute("data-slug");
    svg?.classList.toggle("is-lit", Boolean(slug));
    for (const g of svg?.querySelectorAll(".gmap-spoke") ?? []) {
      g.classList.toggle("is-lit", g.getAttribute("data-slug") === slug);
    }
  }
  /** @param {Event} _ev */
  function offPoint(_ev) {
    svg?.classList.remove("is-lit");
    for (const g of svg?.querySelectorAll(".gmap-spoke") ?? []) g.classList.remove("is-lit");
  }
  /** @param {Event} ev */
  function onActivate(ev) {
    const node = ev.target instanceof Element ? ev.target.closest(".gnode") : null;
    const slug = node?.getAttribute("data-slug");
    if (slug) location.hash = `#/graph/${encodeURIComponent(slug)}`;
  }
  /** @param {KeyboardEvent} ev */
  function onKey(ev) {
    if (ev.key === "Enter" || ev.key === " ") onActivate(ev);
  }

  return () => {
    cancelAnimationFrame(raf);
    host.removeEventListener("pointerover", onPoint);
    host.removeEventListener("focusin", onPoint);
    host.removeEventListener("pointerout", offPoint);
    host.removeEventListener("focusout", offPoint);
    host.removeEventListener("click", onActivate);
    host.removeEventListener("keydown", onKey);
  };
}
