# What using this actually looks like: open your agent in the folder and ask.
# No CLI to learn, no server to run -- the agent calls the memory CLI itself.
#
# Needs the agent workspace, not just a store:
#   ./docs/assets/demo-workspace.sh /tmp/pm-claude-demo
#   vhs docs/assets/tapes/ask-claude.tape
#
# Two things happen off camera, both so the cast shows the steady state rather
# than one machine's incidental state:
#   - the first-run folder-trust dialog is accepted
#   - one warm-up turn scrolls Claude Code's startup header out of the
#     transcript. That header carries whatever SessionStart hooks, plugins and
#     account notices the recording machine happens to have, none of which
#     belong in a public asset. Ctrl+L does NOT work here: it redraws the
#     header rather than dropping it.
Output docs/assets/ask-claude.gif

Set Shell "bash"
Set FontSize 15
Set Width 1400
Set Height 640
Set Padding 24
Set TypingSpeed 22ms
Set Theme { "name": "paper", "background": "#f9f9f7", "foreground": "#0b0b0b", "cursor": "#2a78d6", "selection": "#cde2fb", "black": "#0b0b0b", "red": "#8a2b00", "green": "#006300", "yellow": "#8a5a00", "blue": "#1c60b4", "magenta": "#6e3fa3", "cyan": "#1c7b86", "white": "#52514e", "brightBlack": "#6e6d66", "brightRed": "#8a2b00", "brightGreen": "#006300", "brightYellow": "#8a5a00", "brightBlue": "#2a78d6", "brightMagenta": "#6e3fa3", "brightCyan": "#1c7b86", "brightWhite": "#0b0b0b" }

Hide
Type "cd /tmp/pm-claude-demo && unset CLAUDE_CODE_CHILD_SESSION && export PS1='$ ' && clear"
Enter
Sleep 2s

Type "claude"
Enter
Sleep 14s
Down
Sleep 500ms
Enter
Sleep 12s

Type "List every memory in the store, one line each: date, type, title."
Enter
Sleep 70s
Show

Type "Is the queue technology decision still open?"
Sleep 800ms
Enter
Sleep 50s
