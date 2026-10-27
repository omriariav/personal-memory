import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackWrite } from "./server.js";

/**
 * The UI server binds 127.0.0.1, which keeps it off the network but does
 * nothing about a page the user already has open — that browser is on the
 * loopback interface too. These cover the guard that refuses such a write.
 */

test("a loopback origin on a loopback host is allowed", () => {
  for (const origin of ["http://127.0.0.1:4664", "http://localhost:4664", "http://[::1]:4664"]) {
    assert.equal(isLoopbackWrite({ origin, host: "127.0.0.1:4664" }), true, origin);
  }
});

test("a non-browser client sending no Origin is allowed", () => {
  // curl, the CLI, and the test harness itself send no Origin at all.
  assert.equal(isLoopbackWrite({ host: "127.0.0.1:4664" }), true);
  assert.equal(isLoopbackWrite({ origin: "", host: "localhost:4664" }), true);
});

test("a cross-origin write is refused", () => {
  assert.equal(isLoopbackWrite({ origin: "https://evil.example", host: "127.0.0.1:4664" }), false);
  // A loopback-looking subdomain is not loopback.
  assert.equal(
    isLoopbackWrite({ origin: "http://127.0.0.1.evil.example", host: "127.0.0.1:4664" }),
    false,
  );
});

test("an opaque origin is refused", () => {
  // A sandboxed iframe or a file:// page sends the literal string "null".
  assert.equal(isLoopbackWrite({ origin: "null", host: "127.0.0.1:4664" }), false);
});

test("a non-loopback Host is refused even with no Origin", () => {
  // This is the DNS-rebinding case: the name resolves to 127.0.0.1, but the
  // request still carries the attacker's own Host header.
  assert.equal(isLoopbackWrite({ host: "rebind.evil.example" }), false);
  assert.equal(isLoopbackWrite({}), false);
});

test("a malformed Origin or Host is refused rather than throwing", () => {
  assert.equal(isLoopbackWrite({ origin: "::::", host: "127.0.0.1:4664" }), false);
  assert.equal(isLoopbackWrite({ host: "::::" }), false);
});
