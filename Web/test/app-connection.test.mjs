import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DemoHP97SDevice } from "../hp97s.js";

// Exercise the real app and Web Serial adapter without opening a physical port.
// Minimal DOM objects supply render targets, not a browser or a calculator emulator.
class Element {
  constructor(id = "") {
    Object.assign(this, { id, value: "", textContent: "", dataset: {}, disabled: false, hidden: false, checked: false, children: [], events: {}, classList: { toggle() {} } });
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { return []; }
  setAttribute() {}
  addEventListener(name, handler) { this.events[name] = handler; }
  close() {}
  showModal() {}
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const information = [0x55, 0x61, 0xFD, 0x91, 0x21, 0x05, 0x11, 0];

async function setup(respond = () => information.map(byte => [byte])) {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const nodes = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  nodes.storageBlock.value = nodes.storageSlot.value = "0";
  const timers = new Map();
  let timerId = 0, incoming;
  const writes = [];
  const port = {
    open: async () => {},
    getInfo: () => ({ bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb" }),
    close: async () => {},
    readable: new ReadableStream({ start(controller) { incoming = controller; } }),
    writable: new WritableStream({ write(bytes) {
      writes.push([...bytes]);
      const replies = respond([...bytes]);
      for (const reply of replies ?? []) incoming.enqueue(Uint8Array.from(reply));
    } }),
  };
  const navigator = { serial: { requestPort: async () => port } };
  const serialSource = await readFile(new URL("../serial.js", import.meta.url), "utf8");
  const WebSerialTransport = new Function("navigator", `${serialSource.replace("export class", "class")}\nreturn WebSerialTransport;`)(navigator);
  const globals = {
    navigator, WebSerialTransport,
    document: {
      querySelectorAll: selector => selector === "[id]" ? Object.values(nodes) : [],
      createElement: () => new Element(),
    },
    window: { addEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  let source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/g)];
  for (const [statement, bindings, path] of imports) {
    if (!path.startsWith("./serial.js")) {
      const module = await import(new URL(`../${path.split("?")[0].slice(2)}`, import.meta.url));
      for (const name of bindings.split(",").map(value => value.trim()).filter(Boolean)) globals[name] = module[name];
    }
    source = source.replace(statement, "");
  }
  const app = new Function(...Object.keys(globals), `${source}\nreturn { connect, disconnect, readSettings, hp97sAction, state, verifiedFirmware };`)(...Object.values(globals));
  return { app, nodes, writes, incoming, timers, port, flush };
}

test("app sends only 07 and receives a fragmented firmware-21 reply through Web Serial with HP-97S off", async t => {
  const { app, nodes, writes } = await setup();
  t.after(() => app.disconnect());
  await app.connect();
  assert.deepEqual(writes, [], "Connecting must not enable HP-97S or send any commands");
  await app.readSettings();
  await flush();
  assert.deepEqual(writes, [[7]]);
  assert.equal(app.state.hp97s, null);
  assert.equal(app.state.bytesReceived, 8);
  assert.equal(app.verifiedFirmware(), true);
  assert.equal(nodes.firmware.textContent, "21");
  assert.equal(nodes.readMemory.disabled, false);
});

test("app resumes normal settings reads after a confirmed HP-97S mode exit", async t => {
  const peer = new DemoHP97SDevice();
  const { app, writes } = await setup(bytes => bytes[0] === 7 ? [information] : [peer.write(bytes)]);
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  await flush();
  await app.hp97sAction("toggle");
  await app.readSettings();
  assert.deepEqual(writes, [[7], [0x12]], "A normal query must not escape into active HP-97S mode");
  await app.hp97sAction("status");
  await app.hp97sAction("toggle");
  await app.readSettings();
  await flush();
  assert.deepEqual(writes, [[7], [0x12], [0xF0], [0xF5], [7]]);
  assert.equal(app.verifiedFirmware(), true);
});

test("app reports a settings timeout if the Bluetooth port opens but returns no bytes", async t => {
  const { app, nodes, writes, timers } = await setup(() => []);
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  timers.get(app.state.pending.timer)();
  await flush();
  assert.deepEqual(writes, [[7]], "No reset, HP-97S exit or repeated query may be guessed automatically");
  assert.equal(app.state.bytesReceived, 0);
  assert.equal(app.verifiedFirmware(), false);
  assert.match(nodes.status.textContent, /timed out/);
  assert.equal(nodes.hp97sToggle.disabled, true);
  assert.match(nodes.connectionDiagnosis.textContent, /no calculator reply arrived/);
  assert.equal(nodes.connectionRecovery.hidden, false);
});

test("app displays the user's F5 entry response and keeps all calculator actions locked", async t => {
  const { app, nodes, writes } = await setup(bytes => bytes[0] === 7 ? [information] : [[0xF5]]);
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  await flush();
  await app.hp97sAction("toggle");
  assert.equal(app.state.hp97sRecovery, true);
  assert.equal(nodes.hp97sMode.textContent, "Recovery required");
  assert.match(nodes.hp97sMessage.textContent, /F5.*separate 97S mode/);
  for (const id of ["readSettings", "readMemory", "readClock", "setClock", "readSlot", "scanDirectory", "hp97sToggle", "hp97sReadStatus", "hp97sSend"]) assert.equal(nodes[id].disabled, true, id);
  await app.readSettings();
  await app.hp97sAction("status");
  await app.disconnect();
  assert.deepEqual(writes, [[7], [0x12]], "Recovery/disconnect must not send guessed reset or exit bytes");
});

test("app distinguishes successful live mode entry from the subsequent F5 status failure", async t => {
  const { app, nodes, writes } = await setup(bytes => bytes[0] === 7
    ? [[0x55], [0x61, 0xDD, 0x91, 0x21, 5, 0x11, 0]]
    : [[bytes[0] === 0x12 ? 0xFF : 0xF5]]);
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  await flush();
  await app.hp97sAction("toggle");
  assert.equal(nodes.hp97sMode.textContent, "On");
  await app.hp97sAction("status");
  assert.match(nodes.hp97sMessage.textContent, /entry was acknowledged.*status query returned F5/);
  assert.equal(nodes.hp97sMode.textContent, "Recovery required");
  assert.equal(nodes.hp97sReady.textContent, "Unknown");
  assert.equal(nodes.hp97sRecoveryPanel.hidden, false);
  for (const id of ["readSettings", "readMemory", "readClock", "hp97sToggle", "hp97sReadStatus", "hp97sSend"]) assert.equal(nodes[id].disabled, true, id);
  await app.hp97sAction("status");
  await app.readSettings();
  await app.disconnect();
  assert.deepEqual(writes, [[7], [0x12], [0xF0]]);
});

test("failed settings refresh clears earlier firmware verification and dependent controls", async t => {
  let responding = true;
  const { app, nodes, timers } = await setup(() => responding ? [information] : []);
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  await flush();
  assert.equal(app.verifiedFirmware(), true);
  app.state.clockVerified = true;
  responding = false;
  await app.readSettings();
  timers.get(app.state.pending.timer)();
  assert.equal(app.verifiedFirmware(), false);
  assert.equal(app.state.clockVerified, false);
  for (const id of ["readMemory", "readClock", "setClock", "readSlot", "scanDirectory", "hp97sToggle"]) assert.equal(nodes[id].disabled, true, id);
  responding = true;
  await app.readSettings();
  await flush();
  assert.equal(app.verifiedFirmware(), true);
  assert.equal(nodes.connectionRecovery.hidden, true);
});

test("app distinguishes a partial settings response from a silent Bluetooth link", async t => {
  const { app, nodes, timers } = await setup(() => [[0x55, 0x61]]);
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  await flush();
  timers.get(app.state.pending.timer)();
  assert.match(nodes.connectionDiagnosis.textContent, /2 of the expected 8/);
  assert.equal(app.state.bytesReceived, 2);
  assert.equal(app.verifiedFirmware(), false);
});

test("app reports a failed serial write without claiming the query was sent", async t => {
  const { app, nodes } = await setup(() => { throw new Error("Disconnected while sending"); });
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  await flush();
  assert.match(nodes.connectionDiagnosis.textContent, /did not confirm completion/);
  assert.match(nodes.status.textContent, /Disconnected while sending/);
  assert.equal(nodes.activity.textContent.includes("Browser finished sending"), false);
});

test("app ignores replies belonging to the old connection after disconnect", async t => {
  const { app, writes } = await setup(() => []);
  t.after(() => app.disconnect());
  await app.connect();
  await app.readSettings();
  const oldTransport = app.state.transport;
  await app.disconnect();
  oldTransport.onBytes(Uint8Array.from(information));
  await flush();
  assert.deepEqual(writes, [[7]]);
  assert.equal(app.verifiedFirmware(), false);
  assert.equal(app.state.bytesReceived, 0);
});
