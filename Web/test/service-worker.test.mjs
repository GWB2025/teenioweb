import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("Pages worker preserves other projects' caches and ignores requests outside its scope", async () => {
  const scope = "https://gwb2025.github.io/teenioweb/";
  const current = `teenio-web:${scope}:v0.7.1`;
  const previous = `teenio-web:${scope}:v0.3.1`;
  const otherProject = "teenio-web:https://gwb2025.github.io/another-project/:v0.3.1";
  const removed = [];
  const handlers = {};
  let claimed = false;
  runInNewContext(await readFile(new URL("../sw.js", import.meta.url), "utf8"), {
    URL,
    self: {
      registration: { scope },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { claim: () => { claimed = true; } },
    },
    caches: {
      keys: async () => [current, previous, otherProject, "unrelated-app-v1"],
      delete: async key => { removed.push(key); },
    },
  });
  let completion;
  handlers.activate({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.deepEqual(removed, [previous]);
  assert.equal(claimed, true);
  for (const url of ["https://gwb2025.github.io/another-project/", "https://example.com/teenioweb/"]) {
    handlers.fetch({ request: { method: "GET", url }, respondWith: () => assert.fail("Intercepted another site's request") });
  }
});
