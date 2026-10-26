# Reference sources

The people/team graph is built from what agents write in frontmatter, so slug
quality normally rests on heuristics. A reference source gives it ground truth:
an authoritative directory you already have — a company directory, an LDAP or HR
export, a contacts API, a hand-kept CSV — exposed to the store as a local
lookup command.

> **Off by default — nothing runs until you turn one on.** The repo ships a
> single template, `sources/people-directory.md`, with `enabled: false` and a
> placeholder command. A fresh clone consults no directory, runs no command, and
> behaves exactly as it did before this feature existed. Enabling a source is a
> deliberate, two-part act: point it at a lookup command that works on your
> machine, *and* set `enabled: true`.

## Shape

Sources follow the connector layering: `sources/<name>.md` is the generic
git-tracked template, and a private `memory/sources/<name>.md` override
(gitignored) carries the real command. The frontmatter declares the lookup
contract; the body tells agents when to consult it:

```yaml
name: people-directory
kind: person             # what this source resolves: person | team
enabled: false           # ships false; flip it once the command below works
lookup:
  command: "my-directory lookup {query}"   # prints a JSON array of matches
  refresh: "my-directory sync"             # optional: refresh a local cache
  cache_ttl_days: 14
```

The command receives `{query}` shell-quoted and prints a JSON array of matches,
minimally `[{"name": "Jane Doe", "id": "jdoe", "title": "…", "team": "…"}]`. It
is user-supplied and local-first — the store never ships credentials and never
fetches anything itself.

## At most one source is active

Reconciliation consults a single source, so a second enabled one would never be
read — it would sit there looking active while doing nothing, and a file whose
name sorts earlier would silently shadow the one that works. Enabling a source
therefore turns off any other: the UI asks first and names what it will switch
off, and the rule is enforced server-side, so hand-edited frontmatter cannot get
around it. Zero enabled sources is the default and a perfectly good state.

## Managing them in the UI

The Sources screen (`#/sources`) lists every resolved source with its kind,
where it resolved from, whether it is enabled, and its lookup command — and
flags any file that fails validation. A disabled source carries a `DISABLED`
badge, and its detail screen leads with a switch that says what each state
means: *"consulted by nothing — the command never runs"* versus *"consulted
during `maintenance`; its command will run"*. Flipping the switch rewrites only
that one frontmatter line — the command, its comments and the agent guidance all
survive — and the switch is unavailable on a file that does not parse.

Opening a source also edits it as raw Markdown; saving always writes the private
override in `memory/sources/`, never the git-tracked template. A source created
from the UI starts `enabled: false`, so a half-written command can never go live
by accident.

There is no "test this lookup" button and no endpoint that runs a command you
type — the Sources screen only reads and writes files. Be aware, though, that an
enabled source's command *is* executed whenever the maintenance audit is
rebuilt: `memory maintenance`, the scheduled run, and any UI action that
refreshes the audit (a slug merge, a dismissal, a chain link). That is the point
of the feature, but it means enabling a source means a local command of yours
runs on those events.

## Where the store uses it

- **`memory maintenance` slug hygiene.** Before reporting a person/team merge
  suggestion, both slugs are looked up. Two matches with differing stable ids →
  the suggestion is auto-dismissed, recorded in the audit with the evidence; the
  same identity → its confidence is boosted. Matches without ids can only
  confirm, never refute. A disabled source, a failed command, or non-JSON output
  degrades silently to the existing heuristics, and the same reconciliation runs
  wherever the audit is rebuilt (CLI, UI, scheduled maintenance). Auto-dismissed
  pairs are not hidden: the Maintenance screen lists them under their own
  heading with the directory's reasoning, and keeps the normal merge/ignore
  actions so a wrong dismissal can be overridden.
- **Agent slug minting.** Agents consult an enabled source before minting a new
  person or team slug. Exactly one match mints from the canonical directory name
  (tagged `slug-minted-from-directory`); zero or multiple matches mint exactly as
  they would with no source — derived from the name as given, and offered for
  confirmation. A source decides *which* slug gets minted, never *whether* one
  does, so a person your directory has never heard of still gets one. See
  [AGENTS.md](../AGENTS.md).

Sources never gate a write — capture stays immediate; they only make suggestions
and repairs smarter. `memory sources` lists and validates the resolved files.
