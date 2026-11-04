// What the address box opens for what's typed: a URL as is, localhost and host:port over http,
// a bare domain over https, anything else as a Google search. `node url.cjs` checks it.
function toUrl(text) {
  const s = text.trim();
  // Before the scheme test: "localhost:3000" would otherwise read as scheme "localhost".
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|file|chrome|view-source):/i.test(s)) return s;
  if (/^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

module.exports = { toUrl };

if (require.main === module) {
  const assert = require("node:assert");
  assert.equal(toUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(toUrl("localhost:3000/a?b=1"), "http://localhost:3000/a?b=1");
  assert.equal(toUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(toUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(toUrl("about:blank"), "about:blank");
  assert.equal(toUrl("example.com"), "https://example.com");
  assert.equal(toUrl("en.wikipedia.org/wiki/Terminal_emulator"), "https://en.wikipedia.org/wiki/Terminal_emulator");
  assert.equal(toUrl("herdr terminal"), "https://www.google.com/search?q=herdr%20terminal");
  console.log("toUrl ok");
}
