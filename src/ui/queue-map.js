// @ts-check
/**
 * The review queues drawn as lanes. One lane per shared graph, running from
 * the default graph on the left to that graph on the right, with the pending
 * candidates waiting as motes behind a gate.
 *
 * The registry map one tab over answers "what overlaps with what", and is
 * radial because the store is a hub with spokes. This answers a different
 * question — "what is waiting, and where" — and a queue is a line: lanes put
 * every graph's backlog on a shared horizontal scale, so a glance says which
 * one needs you. Same hub vocabulary (`.gnode*`), so the default graph reads
 * as the same object on both screens.
 *
 * Layout is deterministic; only the motes move. The maths are exported
 * because they are what decides whether anything is legible — the renderer
 * itself is verified by eye at 127.0.0.1:4664.
 */

import { esc } from "./graph-model.js";

const VB_W = 980;
const HUB_X = 86;
const GATE_X = 468;
const NODE_X = 570;
const R_HUB = 54;
const R_MIN = 20;
const R_MAX = 34;
const PAD_TOP = 46;
const LANE_GAP = 92;
const PAD_BOTTOM = 34;
/** Past this many, the gate's number carries the magnitude — 200 candidates
 *  cannot be 200 dots, and the attempt turns the map into static. */
export const MAX_MOTES = 7;
const MOTE_GAP = 26;
/** The first mote sits this far back from the gate. */
const MOTE_LEAD = 34;
/** seconds for one bob */
const BOB_PERIOD = 3.4;

/** Height of the whole map for `n` lanes. Floors at one lane's worth so an
 * empty registry still draws a sensible frame.
 * @param {number} n @returns {number} */
export function queueMapHeight(n) {
  return PAD_TOP + Math.max(1, n) * LANE_GAP + PAD_BOTTOM;
}

/** Vertical centre of lane `i`.
 * @param {number} i @returns {number} */
export function laneY(i) {
  return PAD_TOP + i * LANE_GAP + LANE_GAP / 2;
}

/** Disc radius for a graph, by member count. Square-rooted so a graph many
 * times smaller than another is still a disc rather than a dot.
 * @param {number} members @param {number} max @returns {number} */
export function nodeRadius(members, max) {
  if (max <= 0) return R_MIN;
  const ratio = Math.sqrt(Math.min(Math.max(members, 0), max) / max);
  return R_MIN + (R_MAX - R_MIN) * ratio;
}

/** Resting x of mote `i` of `k`, queueing back from the gate. Strictly
 * decreasing in `i`, and never past the start of the lane.
 * @param {number} i @param {number} k @returns {number} */
export function moteSlot(i, k) {
  const shown = Math.min(k, MAX_MOTES);
  const span = Math.max(0, shown - 1) * MOTE_GAP;
  const first = GATE_X - MOTE_LEAD;
  // Compress the spacing rather than run off the lane when the queue is full.
  const room = first - (HUB_X + R_HUB + 16);
  const gap = span > room && shown > 1 ? room / (shown - 1) : MOTE_GAP;
  return first - i * gap;
}

/** Vertical bob for mote `i` of lane `l` at time `t`. Bounded, staggered, and
 * exactly 0 at t=0 so a reduced-motion render sits on the lane.
 * @param {number} t @param {number} i @param {number} l @returns {number} */
export function moteDrift(t, i, l) {
  return Math.sin(((t / BOB_PERIOD) * 2 * Math.PI) + i * 0.7 + l * 1.3) * 3.2 * Math.min(1, t);
}

/** "today" / "yesterday" / "6d ago" / "3w ago" / "never".
 * @param {string | undefined} iso @param {Date} [now] @returns {string} */
export function relativeDate(iso, now = new Date()) {
  if (!iso) return "never";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "never";
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** How a candidate got proposed, in words.
 * @param {string} proposedBy @param {"copy"|"move"} action @returns {string} */
export function queueSourceLabel(proposedBy, action) {
  const verb = action === "move" ? " → move" : "";
  if (proposedBy === "rules") return `standing rule${verb}`;
  if (proposedBy === "add") return `you, at capture${verb}`;
  if (proposedBy === "review") return `queued from this screen${verb}`;
  return `routine · ${proposedBy}${verb}`;
}

/**
 * Parse a `#/graphs…` hash into the tab (or manifest) it names.
 *
 * Deliberately an exact-segment parse rather than a `startsWith` test: a
 * graph slugged `queue-archive` must land on its manifest, not be read as the
 * review queue. Lives here rather than in app.js so it can be tested
 * headlessly — app.js touches `document` at module scope.
 *
 * @param {string} hash
 * @returns {{ kind: "tab", tab: "graphs"|"rules"|"queue", slug: string }
 *          | { kind: "manifest", slug: string }
 *          | null}
 */
export function parseGraphsHash(hash) {
  if (hash !== "#/graphs" && !hash.startsWith("#/graphs/") && hash !== "#/graphs/") return null;
  const rest = hash.slice("#/graphs".length).replace(/^\//, "");
  if (rest === "") return { kind: "tab", tab: "graphs", slug: "" };
  const slash = rest.indexOf("/");
  const head = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash + 1);
  if (head === "rules" && tail === "") return { kind: "tab", tab: "rules", slug: "" };
  if (head === "queue") return { kind: "tab", tab: "queue", slug: decodeURIComponent(tail) };
  return { kind: "manifest", slug: decodeURIComponent(rest) };
}

/** @typedef {{ graph: string, pending: number, blocked: number, stale: number,
 *              members: number, lastReviewedAt?: string, sweptThrough?: string,
 *              sweptAt?: string }} QueueLane */
/** @typedef {{ slug: string, members: number, pending: number, motes: number,
 *              empty: boolean, lit: boolean, label: string, stale: boolean,
 *              y: number, r: number }} LaneRow */

/**
 * The view model: everything the renderer needs, decided here so the rules
 * ("no pending ⇒ dashed and dimmed", "the selected lane is lit") are
 * assertions rather than something to eyeball.
 *
 * @param {QueueLane[]} lanes
 * @param {string} selected
 * @param {Date} [now]
 * @returns {LaneRow[]}
 */
export function laneRows(lanes, selected, now = new Date()) {
  const maxMembers = lanes.reduce((m, l) => Math.max(m, l.members), 0);
  return lanes.map((l, i) => ({
    slug: l.graph,
    members: l.members,
    pending: l.pending,
    motes: Math.min(l.pending, MAX_MOTES),
    empty: l.pending === 0,
    lit: l.graph === selected,
    // Staleness is the server's call, not the browser's — otherwise the CLI
    // and the UI drift on what "recently swept" means.
    stale: l.stale > 0,
    label:
      `${l.members} member${l.members === 1 ? "" : "s"}` +
      ` · reviewed ${relativeDate(l.lastReviewedAt, now)}` +
      ` · swept ${l.sweptThrough ? relativeDate(l.sweptAt, now) : "never"}`,
    y: laneY(i),
    r: nodeRadius(l.members, maxMembers),
  }));
}

/**
 * Draw the lane map into `host`.
 *
 * Owns no selection state: activating a lane sets the hash and app.js
 * re-renders with a new `selected`. A module-local "current lane" would
 * desync from the route the first time someone hit Back.
 *
 * @param {HTMLElement} host
 * @param {QueueLane[]} lanes
 * @param {string} selected  "" when no lane is chosen
 * @returns {() => void} stop — cancels the loop and unbinds every listener
 */
export function renderQueueMap(host, lanes, selected) {
  if (lanes.length === 0) {
    host.innerHTML = `<div class="qmap qmap-empty"><p>No shared graphs yet — create one and its review queue appears here.</p></div>`;
    return () => {};
  }

  const rows = laneRows(lanes, selected);
  const h = queueMapHeight(rows.length);
  const hubY = h / 2;
  const waiting = lanes.reduce((n, l) => n + l.pending, 0);

  host.innerHTML = `
    <div class="qmap">
      <svg viewBox="0 0 ${VB_W} ${h}" role="img" aria-label="Review queues by graph">
        <g class="gnode gnode-hub" aria-hidden="true">
          <circle class="gnode-disc" cx="${HUB_X}" cy="${hubY}" r="${R_HUB}"/>
          <text class="gnode-n" x="${HUB_X}" y="${hubY - 2}" text-anchor="middle">default</text>
          <text class="qlane-sub" x="${HUB_X}" y="${hubY + 16}" text-anchor="middle">${waiting} waiting</text>
        </g>
        ${rows.map((r, i) => lane(r, i, hubY)).join("")}
      </svg>
      <p class="qmap-cap">waiting on you · a dashed lane has nothing queued</p>
    </div>`;

  return animate(host, rows);
}

/** @param {LaneRow} r @param {number} i @param {number} hubY */
function lane(r, i, hubY) {
  const cls = ["qlane", r.empty ? "is-empty" : "", r.lit ? "is-lit" : ""].filter(Boolean).join(" ");
  const startX = HUB_X + R_HUB + 6;
  const motes = Array.from({ length: r.motes }, (_, m) => {
    const x = moteSlot(m, r.pending);
    return `<circle class="qmote" data-m="${m}" cx="${x.toFixed(1)}" cy="${r.y}" r="3.6"/>`;
  }).join("");
  // The curve lets a lane leave the hub at its own height without a kink.
  const d = `M${startX} ${hubY} C${(startX + GATE_X) / 2} ${hubY}, ${(startX + GATE_X) / 2} ${r.y}, ${GATE_X - 48} ${r.y}`;
  return `
    <g class="${cls}" data-slug="${esc(r.slug)}" tabindex="0" role="button"
       aria-label="${esc(r.slug)}: ${r.pending} pending">
      <path class="qlane-line" d="${d}" fill="none"/>
      ${motes}
      <rect class="qgate" x="${GATE_X - 21}" y="${r.y - 15}" width="42" height="30" rx="7"/>
      <text class="qgate-n" x="${GATE_X}" y="${r.y + 5}" text-anchor="middle">${r.pending}</text>
      <circle class="gnode-disc" cx="${NODE_X}" cy="${r.y}" r="${r.r.toFixed(1)}"/>
      <text class="qlane-label" x="${NODE_X + R_MAX + 14}" y="${r.y - 3}">${esc(r.slug)}</text>
      <text class="qlane-sub ${r.stale ? "is-stale" : ""}" x="${NODE_X + R_MAX + 14}" y="${r.y + 14}">${esc(r.label)}</text>
    </g>`;
}

/**
 * Only the motes move — the lanes themselves are fixed, so there is nothing
 * to chase with the eye. Honors reduced motion by pinning t to 0 and never
 * scheduling another frame.
 *
 * @param {HTMLElement} host
 * @param {LaneRow[]} rows
 * @returns {() => void}
 */
function animate(host, rows) {
  const svg = host.querySelector("svg");
  if (!svg) return () => {};
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  let raf = 0;
  const t0 = performance.now();

  /** @param {number} now */
  const frame = (now) => {
    // the screen is rebuilt wholesale on re-render; stop rather than animate
    // a detached tree forever
    if (!host.isConnected) return;
    const t = still ? 0 : (now - t0) / 1000;
    rows.forEach((r, l) => {
      const g = svg.querySelector(`.qlane[data-slug="${CSS.escape(r.slug)}"]`);
      g?.querySelectorAll(".qmote").forEach((mote, m) => {
        mote.setAttribute("cy", (r.y + moteDrift(t, m, l)).toFixed(2));
      });
    });
    if (!still) raf = requestAnimationFrame(frame);
  };
  frame(t0);

  host.addEventListener("click", onActivate);
  host.addEventListener("keydown", onKey);

  /** @param {Event} ev */
  function onActivate(ev) {
    const g = ev.target instanceof Element ? ev.target.closest(".qlane") : null;
    const slug = g?.getAttribute("data-slug");
    if (slug) location.hash = `#/graphs/queue/${encodeURIComponent(slug)}`;
  }
  /** @param {KeyboardEvent} ev */
  function onKey(ev) {
    if (ev.key === "Enter" || ev.key === " ") {
      if (ev.target instanceof Element && ev.target.closest(".qlane")) ev.preventDefault();
      onActivate(ev);
    }
  }

  return () => {
    cancelAnimationFrame(raf);
    host.removeEventListener("click", onActivate);
    host.removeEventListener("keydown", onKey);
  };
}
