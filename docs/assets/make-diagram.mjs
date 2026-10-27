#!/usr/bin/env node
/**
 * Emit the README's graph-flow diagram in a light and a dark variant.
 *
 *   node docs/assets/make-diagram.mjs
 *
 * Two files rather than one adaptive SVG: GitHub strips CSS from SVGs it
 * serves as images, so theme switching has to happen in the <picture> element
 * that references them. Generating both from one source keeps them in step.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = dirname(fileURLToPath(import.meta.url));

const LIGHT = {
  bg: "#f9f9f7",
  surface: "#fcfcfb",
  surfaceAlt: "#f0f0ed",
  ink: "#0b0b0b",
  inkSecondary: "#52514e",
  muted: "#6e6d66",
  grid: "#e1e0d9",
  accent: "#2a78d6",
  accentText: "#1c60b4",
  accentSoft: "#cde2fb",
  green: "#006300",
};

const DARK = {
  bg: "#121211",
  surface: "#1b1b19",
  surfaceAlt: "#232320",
  ink: "#f3f2ed",
  inkSecondary: "#b9b7af",
  muted: "#8d8b83",
  grid: "#35342f",
  accent: "#5ea3f0",
  accentText: "#8cbef5",
  accentSoft: "#203549",
  green: "#5bbf6a",
};

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** One rounded panel with a heading, a caption and a run of entry chips. */
function panel(c, { x, y, w, h, title, caption, chips, footer, accent }) {
  const chipW = (w - 54) / 2;
  const chipH = 28;
  const gap = 10;
  const perRow = 2;
  const chipsSvg = chips
    .map((chip, i) => {
      const cx = x + 22 + (i % perRow) * (chipW + gap);
      const cy = y + 86 + Math.floor(i / perRow) * (chipH + gap);
      const dim = chip.dim === true;
      return `
    <rect x="${cx}" y="${cy}" width="${chipW}" height="${chipH}" rx="6"
          fill="${dim ? "none" : c.surfaceAlt}" stroke="${dim ? c.grid : "none"}"
          stroke-width="1" ${dim ? 'stroke-dasharray="4 3"' : ""}/>
    <text x="${cx + 12}" y="${cy + 19}" font-family="${FONT}" font-size="13"
          fill="${dim ? c.muted : c.inkSecondary}">${dim ? "✕  " : ""}${chip.label}</text>`;
    })
    .join("");

  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"
        fill="${c.surface}" stroke="${accent ? c.accent : c.grid}" stroke-width="${accent ? 2 : 1}"/>
  <text x="${x + 22}" y="${y + 34}" font-family="${FONT}" font-size="17" font-weight="650"
        fill="${c.ink}" letter-spacing="-0.015em">${title}</text>
  <text x="${x + 22}" y="${y + 58}" font-family="${FONT}" font-size="13" fill="${c.muted}">${caption}</text>
  ${chipsSvg}
  <text x="${x + 22}" y="${y + h - 18}" font-family="${FONT}" font-size="12.5" fill="${c.inkSecondary}">${footer}</text>`;
}

function arrow(c, { x1, x2, y, color }) {
  const stroke = color || c.accent;
  return `
  <line x1="${x1}" y1="${y}" x2="${x2 - 10}" y2="${y}" stroke="${stroke}" stroke-width="2"/>
  <path d="M ${x2 - 10} ${y - 5} L ${x2} ${y} L ${x2 - 10} ${y + 5} Z" fill="${stroke}"/>`;
}

/** A route label: bold lead-in, muted qualifier, centred on x. */
function route(c, { x, y, label, sub }) {
  return `
  <text x="${x}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="12.5"
        font-weight="650" fill="${c.accentText}">${label}</text>
  <text x="${x}" y="${y + 16}" text-anchor="middle" font-family="${FONT}" font-size="12"
        fill="${c.muted}">${sub}</text>`;
}

function diagram(c) {
  const W = 1380;
  const H = 510;
  const mid = 262;              // vertical centre of the two panels
  const panelY = 112;
  const panelH = 300;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="A capture lands in the default graph on your disk unless you explicitly ask for a named graph, in which case it is written only there. Entries reach a named shared graph by a standing rule or by a promotion review you confirm entry by entry. A shared graph cannot reference anything that is not in it, and the person you share it with recalls from that graph alone.">
  <rect width="${W}" height="${H}" fill="${c.bg}"/>

  <text x="30" y="34" font-family="${FONT}" font-size="14" fill="${c.inkSecondary}">
    <tspan font-weight="650" fill="${c.ink}">Private by default.</tspan>
    <tspan fill="${c.muted}">  A capture lands at home unless you say otherwise; sharing is a separate, deliberate act.</tspan>
  </text>

  <!-- the exception, drawn as one: an explicit request writes straight into the named graph -->
  <path d="M 77 ${mid - 28} L 77 72 L 845 72 L 845 ${panelY - 10}"
        fill="none" stroke="${c.muted}" stroke-width="1.6" stroke-dasharray="6 4"/>
  <path d="M 840 ${panelY - 20} L 845 ${panelY - 8} L 850 ${panelY - 20} Z" fill="${c.muted}"/>
  <text x="461" y="64" text-anchor="middle" font-family="${FONT}" font-size="12.5" fill="${c.muted}">
    only if you ask for it — <tspan font-family="ui-monospace, monospace" font-size="12">add --graph &lt;name&gt;</tspan> writes there and nowhere else
  </text>

  <rect x="24" y="${mid - 28}" width="106" height="56" rx="10" fill="${c.surfaceAlt}" stroke="${c.grid}"/>
  <text x="77" y="${mid + 5}" text-anchor="middle" font-family="${FONT}" font-size="14"
        font-weight="650" fill="${c.ink}">a capture</text>

  ${arrow(c, { x1: 132, x2: 150, y: mid })}

  ${panel(c, {
    x: 150, y: panelY, w: 340, h: panelH,
    title: "default graph",
    caption: "where captures land",
    chips: [
      { label: "meeting" }, { label: "incident" },
      { label: "decision" }, { label: "note" },
      { label: "1:1" }, { label: "hiring" },
      { label: "feedback" }, { label: "achievement" },
    ],
    footer: "gitignored · its own git repo · never leaves",
  })}

  ${route(c, { x: 590, y: mid - 46, label: "a standing rule", sub: "by tag or type, automatic" })}
  ${arrow(c, { x1: 500, x2: 680, y: mid })}
  ${route(c, { x: 590, y: mid + 40, label: "a promotion review", sub: "you confirm each entry" })}

  ${panel(c, {
    x: 690, y: panelY, w: 340, h: panelH,
    accent: true,
    title: "platform-team graph",
    caption: "only what you put there",
    chips: [
      { label: "meeting" }, { label: "incident" },
      { label: "decision" }, { label: "note" },
      { label: "1:1", dim: true }, { label: "hiring", dim: true },
      { label: "feedback", dim: true }, { label: "achievement" },
    ],
    footer: "self-contained · no reference points outside",
  })}

  ${arrow(c, { x1: 1040, x2: 1072, y: mid })}

  <rect x="1092" y="${mid - 84}" width="248" height="168" rx="12" fill="${c.surface}" stroke="${c.grid}"/>
  <text x="1216" y="${mid - 42}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="650"
        fill="${c.ink}" letter-spacing="-0.015em">their agent</text>
  <text x="1216" y="${mid - 14}" text-anchor="middle" font-family="${FONT}" font-size="12.5" fill="${c.muted}">you hand over the directory;</text>
  <text x="1216" y="${mid + 4}" text-anchor="middle" font-family="${FONT}" font-size="12.5" fill="${c.muted}">they recall from that graph alone</text>
  <text x="1216" y="${mid + 44}" text-anchor="middle" font-family="${FONT}" font-size="12.5" fill="${c.green}">✓ nothing else is reachable</text>

  <text x="30" y="${H - 28}" font-family="${FONT}" font-size="12.5" fill="${c.muted}">
    ✕ marks what was never shared — a named graph is a separate directory on disk, not a filtered view of the default one.
  </text>
</svg>
`;
}

writeFileSync(join(OUT, "graph-flow-light.svg"), diagram(LIGHT));
writeFileSync(join(OUT, "graph-flow-dark.svg"), diagram(DARK));
console.log("✓ wrote graph-flow-light.svg and graph-flow-dark.svg");
