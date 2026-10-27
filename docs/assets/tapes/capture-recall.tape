# Core loop: capture something, ask about it later, see what is still open.
# Regenerate:  ./docs/assets/demo-seed.sh /tmp/pm-demo && vhs docs/assets/tapes/capture-recall.tape
Output docs/assets/capture-recall.gif

Set Shell "bash"
Set FontSize 15
Set Width 1420
Set Height 470
Set Padding 24
Set TypingSpeed 12ms
Set Theme { "name": "paper", "background": "#f9f9f7", "foreground": "#0b0b0b", "cursor": "#2a78d6", "selection": "#cde2fb", "black": "#0b0b0b", "red": "#8a2b00", "green": "#006300", "yellow": "#8a5a00", "blue": "#1c60b4", "magenta": "#6e3fa3", "cyan": "#1c7b86", "white": "#52514e", "brightBlack": "#6e6d66", "brightRed": "#8a2b00", "brightGreen": "#006300", "brightYellow": "#8a5a00", "brightBlue": "#2a78d6", "brightMagenta": "#6e3fa3", "brightCyan": "#1c7b86", "brightWhite": "#0b0b0b" }

Hide
Type "cd /tmp/pm-demo && export PATH=$PWD/bin:$PATH && export PS1='$ ' && clear"
Enter
Sleep 3s
Show

Type "memory add --title 'Read replica for growth experiments?' --type pending-decision --people priya-raman --body 'Needs a cost estimate first.'"
Sleep 600ms
Enter
Sleep 6s

Type "memory recall 'what did we decide about the queue technology?' -k 2"
Sleep 600ms
Enter
Sleep 9s

Type "memory open"
Sleep 600ms
Enter
Sleep 7s
