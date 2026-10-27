# Sharing, the way you'd actually do it: say what the team may see, and let the
# agent build the graph. The 1:1, hiring and feedback entries stay home.
#
#   ./docs/assets/demo-workspace.sh /tmp/pm-claude-demo
#   vhs docs/assets/tapes/share-with-claude.tape
#
# Same two off-camera steps as ask-claude.tape, for the same reasons: accept
# the first-run trust dialog, and run one warm-up turn so Claude Code's startup
# header -- which carries the recording machine's hooks, plugins and account
# notices -- scrolls out of the transcript before recording begins.
Output docs/assets/share-with-claude.gif

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

# Phrased as a decision already made rather than a request to review. The
# promotion review is interactive by design -- good for real use, impossible to
# drive blind from a tape, since its options are generated per run.
Type "Create a platform-team graph and copy the whole queue-technology chain into it -- both decisions and both pending-decisions -- plus the two incidents. Then show me what is in that graph and confirm the 1:1, hiring and feedback entries are not."
Sleep 800ms
Enter
Sleep 200s
