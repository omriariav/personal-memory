# Private by default, shareable on purpose: create a graph, review candidates,
# watch containment refuse an entry whose chain would dangle, then recall
# scoped to the shared graph and find the private 1:1 simply is not in it.
# Regenerate:  ./docs/assets/demo-seed.sh /tmp/pm-demo && vhs docs/assets/tapes/private-to-shared.tape
Output docs/assets/private-to-shared.gif

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

Type "memory graphs create platform-team --display-name 'Platform Team'"
Sleep 600ms
Enter
Sleep 4s

Type "memory promote candidates --to platform-team"
Sleep 600ms
Enter
Sleep 11s

Hide
Type "clear"
Enter
Sleep 1s
Show

# The decision follows a pending-decision. Containment will not let it go
# alone, because a shared graph may never reference a non-member.
Type "memory copy 2026-04-02-payments-pipeline-will-run-on-kafka --to platform-team"
Sleep 600ms
Enter
Sleep 6s

Type "memory copy 2026-03-04-queue-technology-for-the-payments-pipeline-kafka-vs-rabbitmq --to platform-team"
Sleep 600ms
Enter
Sleep 5s

Type "memory copy 2026-04-02-payments-pipeline-will-run-on-kafka --to platform-team"
Sleep 600ms
Enter
Sleep 5s

# The rest of the work artifacts go the same way; promoted off-camera so the
# closing question is asked against a realistic graph.
Hide
Type "for id in 2026-02-10-payments-replatform-kickoff 2026-03-18-checkout-latency-spike-after-the-tuesday-deploy 2026-06-03-payments-replatform-at-100-traffic 2026-06-17-why-the-legacy-writer-path-is-still-around 2026-07-08-deprecating-the-v1-payments-api-in-q4; do memory copy $id --to platform-team >/dev/null; done"
Enter
Sleep 60s
Type "clear"
Enter
Sleep 1s
Show

# The 1:1, the hiring debrief and the feedback never left the default graph.
Type "memory recall 'what do I know about Jane promotion readiness?' --graph platform-team -k 2"
Sleep 600ms
Enter
Sleep 10s
