#!/usr/bin/env node
// Extract a memory entry's title, normalized for use as a git commit subject.
//
// Entries are written by `matter.stringify` (src/ingest.ts), which folds long
// titles into YAML block scalars — `title: >-` with the text on the following
// indented lines. Reading the key's own line therefore yields the literal `>-`,
// which is how the auto-commit hooks produced 1197 commits titled
// "Log memory: >-". Parsing with gray-matter — the same library that wrote the
// file — is what recovers the title across every scalar style.
//
// Prints the title on stdout, or nothing when it cannot be determined. Always
// exits 0: a commit subject is never worth failing a capture over. Callers fall
// back to their own default on empty output.

// Keeps `git log --oneline` readable; entry titles routinely run past 90 chars.
const MAX_SUBJECT = 72;

try {
  const matter = require("gray-matter");
  const file = process.argv[2];
  if (file) {
    const { data } = matter.read(file);
    // Folded scalars carry newlines; a commit subject has to be a single line.
    const title = String((data && data.title) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (title) {
      process.stdout.write(
        title.length > MAX_SUBJECT
          ? `${title.slice(0, MAX_SUBJECT - 1)}…`
          : title,
      );
    }
  }
} catch {
  // Unreadable file, malformed YAML, missing dependency — stay silent and let
  // the caller use its own default.
}
