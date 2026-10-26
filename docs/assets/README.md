# README assets

Everything here is generated from a **throwaway synthetic store**. No real
memory ever appears in a committed asset, and nothing in this directory should
ever be produced by pointing a tool at your own store.

| File | Made by |
|---|---|
| `memory-graph.png` | hand-captured, pre-dates these scripts; sanitized placeholder names |
| `capture-recall.gif` | `tapes/capture-recall.tape` |
| `private-to-shared.gif` | `tapes/private-to-shared.tape` |
| `graph-flow-light.svg`, `graph-flow-dark.svg` | `make-diagram.mjs` |
| `ui-record.png`, `ui-chain.png`, `ui-graphs.png` | `make-screenshots.sh` |

## Regenerating

Node 20+ is required (`nvm use 20`). The casts need
[vhs](https://github.com/charmbracelet/vhs) (`brew install vhs`); the
screenshots need Google Chrome.

```bash
./docs/assets/demo-seed.sh /tmp/pm-demo        # ~15 invented entries, two timeline chains
vhs docs/assets/tapes/capture-recall.tape
node docs/assets/make-diagram.mjs
./docs/assets/make-screenshots.sh /tmp/pm-demo
```

`private-to-shared.tape` creates the `platform-team` graph as part of the cast,
so run it **before** `make-screenshots.sh` if you want the Graphs screen to show
a shared graph:

```bash
vhs docs/assets/tapes/private-to-shared.tape
./docs/assets/make-screenshots.sh /tmp/pm-demo
```

The casts capture new entries that the seed does not create, so a tape cannot be
re-run against a store it has already recorded against — `add` refuses the
duplicate id. Seed a fresh directory for each take and point the tape at it.

## Rules for anything added here

- Generated from the demo store, never from a real one. `make-screenshots.sh`
  refuses a store holding more than 40 entries as a crude guard.
- No real names, companies, channel ids, email addresses or file paths outside
  the demo store.
- Keep GIFs under about 3 MB. The light `paper` theme in the tapes matches the
  app's own palette in `DESIGN.md`.
- Two variants for diagrams (light and dark) referenced from a `<picture>`
  element — GitHub strips CSS from SVGs it serves as images, so a single
  adaptive file will not theme correctly.
