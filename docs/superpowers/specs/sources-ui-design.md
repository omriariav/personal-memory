# Reference sources in the web UI — design

**Date:** 2026-10-26
**Branch:** `integration/pr4-resolved` (PR #4 resolved against current main)
**Status:** design, approved scope — not yet built

## Intent

PR #4 adds reference sources — `sources/<name>.md` files whose frontmatter
declares a lookup contract (a local command resolving a person or team against
an authoritative directory) and whose body is agent guidance. It ships the CLI
half only: `memory sources` lists and validates, and `maintenance` consults an
enabled source to auto-dismiss or boost slug-merge suggestions.

There is no way to create, edit, or enable a source from the web UI, and nothing
in the UI reveals that a source exists, is misconfigured, or acted on a
suggestion. Issue #2 asked for overrides "editable in the web UI like connector
overrides"; PR #4 deferred it. This design covers that follow-up.

## Goals

- Create, edit, and enable a source override from the UI, in the private layer,
  with the same affordances connectors have.
- Surface what reconciliation did — the `sourceDismissed` evidence already
  written into the maintenance audit has no UI surface today.
- Let an agent inspect a private override from the shell without tripping the
  search guard, as it can for connectors.

## Non-goals

- Editing the git-tracked templates under `sources/`. Saves always land in
  `memory/sources/`, exactly as connector saves do.
- Any change to reconciliation semantics, the schema, or the CLI.
- **Running a lookup from the UI.** See "Deferred" below — this was the
  original recommendation and is deliberately out of scope.
- Managing directory credentials. The command is user-supplied and local; the
  store never stores or forwards secrets.

## Anti-goals

- A UI that can save a source the CLI would reject, or vice versa. One
  validation path (`parseSource`), used by both.
- Letting a caller-supplied path reach the filesystem. The write path is built
  from a validated name only, as `writeConnector` does.

## Deferred, with eyes open

**A "test this lookup" panel** was the original recommendation, because
`lookupDirectory()` deliberately degrades to `null` on every failure — command
missing, non-zero exit, timeout, non-JSON output, JSON of the wrong shape. That
is correct behaviour (a directory must never gate a capture), but it means a
misconfigured source is **completely silent**: it does nothing, reports nothing,
and the only symptom is merge suggestions you expected to disappear and didn't.

It is deferred because it requires executing a shell command on an HTTP request,
and `src/server.ts` has no `Origin`/`Host` check today. Building it responsibly
meant shipping that check first; the decision was to do neither for now.

Two consequences the builder should know rather than rediscover:

1. **A misconfigured source stays silent.** The validation error on the file
   catches malformed *text*, not a command that runs and returns nothing useful.
   Item 4 below (`sourceDismissed` surfacing) becomes the only feedback channel,
   which is why it is in scope rather than optional.
2. **The pre-existing CSRF exposure remains.** `POST /api/maintenance/run`
   already reaches `reconcileGraphAudit()`, which runs the configured lookup
   command through a full shell — so once a source is enabled, any page the
   user has open can trigger it. This is a property of PR #4 as merged, not of
   this design, and it should be tracked separately.

If the panel is ever revived, the design notes are in this file's git history:
widen `LookupRunner` to carry stderr and exit status, show stderr but never the
resolved command (it may embed a token), and land the `Origin`/`Host` check
first — allow absent, reject `null`, allow any loopback origin on the listening
port, and require a loopback `Host`.

## The work

### 1. `writeSource()` — `src/sources.ts`

Mirror `writeConnector()` exactly: validate with `parseSource(raw, name)` so
nothing is written on invalid content, `mkdir` the private dir, write to
`<path>.tmp`, `rename` into place, return the path. Always
`memory/sources/<name>.md`; the path is built from `name` alone.

### 2. `GET /api/sources` and `PUT /api/sources/<name>` — `src/server.ts`

`GET` shaped like `apiConnectors`: for each file from `loadSources()`, return
`name`, `kind`, `origin`, `path` (via `relSource`), `enabled`, the `lookup`
block, `body`, `raw`, and `error` when validation failed. No lookup is executed.

`PUT` mirrors `apiPutConnector`: 404 on a name failing the name regex, 400 on an
empty body, the validation error on invalid content, the written path on
success. Reuse `CONNECTOR_NAME` by renaming it to something neutral
(`FILE_NAME`) rather than duplicating the pattern.

### 3. `#/sources` and `#/source/<name>` — `src/ui/app.js`

List screen reusing the connector row pattern: status dot (error / enabled /
disabled), the `kind` badge, the origin badge, the command in `<code>`, and a
"+ new source" modal writing a private override.

Detail screen mounting the existing `mountFileEditor` against the raw file,
led by an **enabled/disabled switch** (added after the first build, on
request). The flip happens server-side in `setSourceEnabled` + `POST
/api/sources/<name>/enabled`, not by rewriting text in the browser: one
validation path, and the command, its comments and the guidance body survive
a toggle untouched. The switch is unavailable on a file that fails validation,
since the flag lives in frontmatter the server would have to rewrite.

**At most one source may be enabled, across kinds** (added on request after
the multi-source behaviour came to light). `reconcileSuggestions` picks a
single source per kind with `usable.find(...)`, and `loadSources` sorts by
filename — so a second enabled source is never consulted, and an
alphabetically-earlier name silently shadows a working one. Rather than warn
about a state that is never useful, the rule removes it: `saveSource` and
`setSourceEnabled` both disable every other enabled source and report which,
so raw saves and hand-edited frontmatter are covered, not just the switch. The
UI asks before switching anything off and names what it will turn off.

Known consequence, accepted: a `person` directory and a `team` directory can
no longer run together, since the limit is global rather than per kind.

The toggle endpoint returns the file **as written**, and the detail screen
re-seeds its editor from that. Without it the editor keeps pre-toggle text and
a later save there silently flips the flag back — a bug found by toggling in
the running app, not by the tests.

**Decision (mine): the "+ new source" modal seeds `enabled: false`**, matching
the shipped template. `SourceSchema` defaults `enabled` to `true`, so without
this a half-written command goes live on the next `maintenance` run. With no
test panel to check it first, defaulting to inert matters more, not less.

### 4. `sourceDismissed` in the maintenance screen

The audit already carries each auto-dismissed suggestion with its directory
evidence, and `getMaintenanceSnapshot` already ships the whole audit to the
browser — only the `GraphAudit` typedef in `app.js` lacks the field. Render them
as a distinct, muted group: "auto-dismissed by people-directory: 'dana-m' and
'dana-n' resolve to different identities".

**Decision (mine): the rows keep the normal suggestion actions** (dry-run /
merge / ignore). A read-only row leaves the user seeing a wrong dismissal with
no remedy but hand-editing the source file.
`/api/maintenance/slugs/merge` already takes kind/from/to, so "merge anyway"
costs nothing and changes no reconciliation semantics — it overrides one
verdict, it does not teach the reconciler anything.

Dismissals only appear after a reconcile-writing run, so a fresh store shows
nothing here until maintenance has run once. Do not paper over that with an
automatic run on page load — the run executes a shell command.

### 5. Guard hooks — DROPPED, the premise was false

This item proposed adding `sources` to the search guard's allowlist, on the
belief that a private override was writable but not shell-readable, unlike
connectors. **Probing the actual hook disproved it**, so the change is not made:

```
DENY   cat memory/connectors/gmail.md
DENY   cat memory/sources/people-directory.md     ← same, not asymmetric
ALLOW  grep -rn lookup sources/                   ← already allowed
```

Naming any store path in a shell read is denied regardless of subdirectory, and
a scoped search of the tracked `sources/` template dir is already allowed
without an allowlist entry. There is no gap to close.

Worse, making the change would have *weakened* the guard. The allowlist is
consulted only in the whole-tree-sweep branch, and it matches loosely:

```
DENY   grep -rli "jane doe" .
ALLOW  grep -rli "connectors" .    ← existing entry already defeats the sweep guard
DENY   grep -rli "sources" .       ← would become ALLOW
```

`sources` is a plausible sweep term — memory frontmatter carries `sources:` and
`source_ids:` — so allowlisting it would let a whole-tree sweep walk the store.

**Separate pre-existing finding, out of scope here:** the sweep branch matches
its allowlist against text that includes non-path tokens, so *any* allowlisted
word anywhere in a command defeats it (`grep -rli "connectors" .` above). That
is a real hole in a safety-critical hook, in both the `.claude` and `.codex`
copies. It deserves its own change with its own tests, not a drive-by fix
inside a UI feature.

### 6. Tests

- `writeSource`: round-trip, rejection of invalid content with nothing written,
  path built from name only.
- Endpoints: mirror `src/server-catalog.test.ts`, which spawns the server as a
  child process and talks HTTP. `GET` shape including a file with a validation
  error; `PUT` rejection cases and a successful write landing in the private
  layer.
- `memory-guards`: a case for the new `sources` allowlist entry.
- No `LookupRunner` work is needed — nothing in this scope executes a lookup.

## What's left to the builder

- Exact markup, class names, and copy, following the existing connector screens.
- Whether `FILE_NAME` is a rename or a second constant.
- Whether the `kind` badge and the command share a row or stack.

## Open question, carried from the conversation

Whether a usable directory lookup exists on the user's machine at all. This does
not change the design — it changes whether building it is worth the time. Today
every slug-hygiene suggestion in the live store is `tag:` kind, and reference
sources resolve only `person` and `team`, so the feature is correct and inert.

The test panel would have been the cheapest way to answer this; with it
deferred, the answer has to come from trying a command at the shell and pasting
a working one into the override.
