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
  const chipW = 150;
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

function arrow(c, { x1, x2, y, label, sub }) {
  const mid = (x1 + x2) / 2;
  return `
  <line x1="${x1}" y1="${y}" x2="${x2 - 10}" y2="${y}" stroke="${c.accent}" stroke-width="2"/>
  <path d="M ${x2 - 10} ${y - 5} L ${x2} ${y} L ${x2 - 10} ${y + 5} Z" fill="${c.accent}"/>
  <text x="${mid}" y="${y - 16}" text-anchor="middle" font-family="${FONT}" font-size="13"
        font-weight="600" fill="${c.accentText}">${label}</text>
  <text x="${mid}" y="${y + 26}" text-anchor="middle" font-family="${FONT}" font-size="12"
        fill="${c.muted}">${sub}</text>`;
}

function diagram(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="420" viewBox="0 0 1280 420" role="img"
     aria-label="Every capture lands in the default graph on your disk. Entries you promote are copied into a named shared graph that cannot reference anything you did not promote, and the person you share it with recalls from that graph alone.">
  <rect width="1280" height="420" fill="${c.bg}"/>

  ${panel(c, {
    x: 40, y: 70, w: 380, h: 290,
    title: "default graph",
    caption: "every capture lands here",
    chips: [
      { label: "meeting" }, { label: "incident" },
      { label: "decision" }, { label: "note" },
      { label: "1:1" }, { label: "hiring" },
      { label: "feedback" }, { label: "achievement" },
    ],
    footer: "gitignored · its own git repo · never leaves",
  })}

  ${arrow(c, { x1: 440, x2: 540, y: 205, label: "you confirm", sub: "per entry" })}

  ${panel(c, {
    x: 560, y: 70, w: 380, h: 290,
    accent: true,
    title: "platform-team graph",
    caption: "only what you promoted",
    chips: [
      { label: "meeting" }, { label: "incident" },
      { label: "decision" }, { label: "note" },
      { label: "1:1", dim: true }, { label: "hiring", dim: true },
      { label: "feedback", dim: true }, { label: "achievement" },
    ],
    footer: "self-contained · no reference points outside",
  })}

  ${arrow(c, { x1: 960, x2: 1040, y: 205, label: "hand over", sub: "a directory" })}

  <rect x="1060" y="130" width="180" height="170" rx="12" fill="${c.surface}" stroke="${c.grid}"/>
  <text x="1150" y="180" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="650"
        fill="${c.ink}" letter-spacing="-0.015em">their agent</text>
  <text x="1150" y="208" text-anchor="middle" font-family="${FONT}" font-size="12.5" fill="${c.muted}">recalls from</text>
  <text x="1150" y="226" text-anchor="middle" font-family="${FONT}" font-size="12.5" fill="${c.muted}">that graph alone</text>
  <text x="1150" y="262" text-anchor="middle" font-family="${FONT}" font-size="12.5" fill="${c.green}">✓ nothing else</text>

  <text x="40" y="40" font-family="${FONT}" font-size="14" fill="${c.inkSecondary}">
    <tspan font-weight="650" fill="${c.ink}">Private by default.</tspan>
    <tspan fill="${c.muted}">  Capture always lands at home; sharing is a separate, deliberate act.</tspan>
  </text>

  <text x="40" y="395" font-family="${FONT}" font-size="12.5" fill="${c.muted}">
    ✕ marks what was never promoted — a shared graph is a separate directory on disk, not a filtered view of this one.
  </text>
</svg>
`;
}

writeFileSync(join(OUT, "graph-flow-light.svg"), diagram(LIGHT));
writeFileSync(join(OUT, "graph-flow-dark.svg"), diagram(DARK));
console.log("✓ wrote graph-flow-light.svg and graph-flow-dark.svg");
