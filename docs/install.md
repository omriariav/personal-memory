# Install and setup

Requires Node.js 20 or newer.

```bash
git clone https://github.com/vladimanaev/personal-memory.git
cd personal-memory
npm install
npm run index
npm start
```

`npm start` opens the local UI at `http://127.0.0.1:4664`. On a fresh clone the
store is empty — the UI is a record browser, not an onboarding wizard, so it
will look bare until you capture something.

## Running the UI from anywhere

Link the `memui` helper onto your `PATH`:

```bash
ln -s "$PWD/scripts/memui.sh" ~/.local/bin/memui
memui            # interactive menu: start / stop / restart / open / logs
memui status     # or: start | stop | restart | open | logs | home
```

The server runs in the background with logs in `~/.cache/memui/`. `MEMORY_HOME`
picks the store and `MEMUI_PORT` the port.

## Using it with an agent

Open Claude Code or Codex with the repository as the working directory and ask
naturally. The agent reads the repo instructions, uses the memory skills, and
calls the CLI behind the scenes.

```bash
cd personal-memory
claude
```

Or open the folder as the workspace in Codex.

## Using it from any other project

The memory skills also ship as a plugin, so a capture-worthy moment in another
repo ("remember that we decided X" mid-review) doesn't require switching
sessions. The repo itself is the marketplace — one manifest serves both CLIs:

```bash
# Claude Code (inside a session)
/plugin marketplace add vladimanaev/personal-memory
/plugin install personal-memory@personal-memory

# Codex
codex plugin marketplace add https://github.com/vladimanaev/personal-memory
codex plugin add personal-memory@personal-memory
```

> **Install from Git, not from a local path.** A local-path marketplace add
> copies the working tree verbatim into the plugin cache — including the
> private, gitignored `memory/` store. A Git add clones tracked content only.

Then tell the installed skills where your clone lives, since the CLI resolves
the store from its working directory:

```bash
# in your shell profile
export MEMORY_HOME="$HOME/path/to/personal-memory"
```

Inside the personal-memory repo the skills keep working as before —
`MEMORY_HOME` is consulted only when you are elsewhere.

## Embeddings

Embeddings run locally by default and no API backend is used unless you set one
explicitly:

```bash
MEMORY_EMBEDDINGS=openai npm run index -- --force
MEMORY_EMBEDDINGS=voyage npm run index -- --force
```

## Pulling from connected sources

Connector pulls use the skill system and the prompts in `connectors/<name>.md`
to fetch, filter, deduplicate and update memories over time. Ask for them in
words:

```text
"Pull recent memories from Gmail, Slack, and Google Chat."
"Use the connector settings to ingest memory-worthy updates from the last week."
"Every 4 hours, pull Gmail and Slack and log anything memory-worthy."
```

`memory connectors` lists and validates the resolved connector files. Per-source
configuration and the private-override layering are described in
[concepts.md](concepts.md#connectors).
