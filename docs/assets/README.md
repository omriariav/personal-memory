# README assets

Everything here is generated from a **throwaway synthetic store**. No real
memory ever appears in a committed asset, and nothing in this directory should
ever be produced by pointing a tool at your own store.

| File | Made by |
|---|---|
| `memory-graph.png` | hand-captured, pre-dates these scripts; sanitized placeholder names |
| `ask-claude.gif` | `tapes/ask-claude.tape` |
| `share-with-claude.gif` | `tapes/share-with-claude.tape` |
| `graph-flow-light.svg`, `graph-flow-dark.svg` | `make-diagram.mjs` |
| `ui-record.png`, `ui-chain.png`, `ui-graphs.png` | `make-screenshots.sh` |

## Regenerating

Node 20+ is required (`nvm use 20`). The casts need
[vhs](https://github.com/charmbracelet/vhs) and
[gifsicle](https://www.lcdf.org/gifsicle/) (`brew install vhs gifsicle`) plus a
working `claude`; the screenshots need Google Chrome.

```bash
node docs/assets/make-diagram.mjs

./docs/assets/demo-seed.sh /tmp/pm-demo
./docs/assets/make-screenshots.sh /tmp/pm-demo

./docs/assets/demo-workspace.sh /tmp/pm-claude-demo
vhs docs/assets/tapes/ask-claude.tape
```

`demo-seed.sh` builds a store; `demo-workspace.sh` builds a store **plus** the
repo's instruction surface, which is what a real agent session needs. The casts
require the workspace.

Always squeeze a fresh cast — vhs output runs 2–4 MB and dedupes to well under
half that with no visible loss on terminal text:

```bash
gifsicle -O3 --lossy=60 --colors 128 docs/assets/ask-claude.gif -o /tmp/out.gif
mv /tmp/out.gif docs/assets/ask-claude.gif
```

## Recording a cast: two things that will bite you

**Claude Code's startup header leaks the recording machine.** It carries
whatever SessionStart hooks, plugins, MCP servers and account notices that
machine has — on the machine these were recorded on, one of them named an
employer. `Ctrl+L` does *not* help: it redraws the header rather than dropping
it. Both tapes instead run one throwaway turn off camera, which scrolls the
header out of the transcript before recording starts.

**A first run in a new folder shows the folder-trust dialog**, which will eat
the first thing you type. The tapes accept it in the same hidden block.

A tape also cannot be re-run against a store it has already recorded against —
`add` refuses the duplicate id, and a cast that creates a graph will refuse the
second time. Build a fresh workspace per take.

Anything interactive beyond a single prompt is a bad fit for a tape. The
promotion review generates its options per run, so blind keystrokes land on
different choices between takes; `share-with-claude.tape` is phrased as a
decision already made so the session completes on its own.

## Rules for anything added here

- Generated from the demo store, never from a real one. `make-screenshots.sh`
  refuses a store holding more than 40 entries as a crude guard.
- No real names, companies, channel ids, email addresses or file paths outside
  the demo workspace. Watch the terminal status line and any banner text, not
  just the content you meant to record.
- Keep GIFs under about 3 MB after `gifsicle`. The light `paper` theme in the
  tapes matches the app's own palette in `DESIGN.md`.
- Two variants for diagrams (light and dark) referenced from a `<picture>`
  element — GitHub strips CSS from SVGs it serves as images, so a single
  adaptive file will not theme correctly.
