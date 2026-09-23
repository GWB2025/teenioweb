import test from "node:test";
import assert from "node:assert/strict";
import { HP97SController, DemoHP97SDevice, encodeHP97SEntry, decodeHP97SStatus } from "../hp97s.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(respond = () => undefined, options = {}) {
  const sent = [], logs = [];
  const controller = new HP97SController({
    ...options,
    onLog: message => logs.push(message),
    write: packet => {
      assert.equal(packet.length, 1, "Each write must contain exactly one binary byte");
      sent.push(packet[0]);
      const reply = respond(packet[0], sent.length - 1);
      if (reply !== undefined) queueMicrotask(() => controller.receive(Array.isArray(reply) ? reply : [reply]));
    },
  });
  return { controller, sent, logs };
}

function scripted(pairs, options) {
  return harness((byte, index) => {
    assert.ok(pairs[index], `Unexpected extra write ${byte}`);
    assert.equal(byte, pairs[index][0]);
    return pairs[index][1];
  }, options);
}

test("HP-97S encodes the CalCom alphabet as individual binary bytes and appends NOP", () => {
  assert.deepEqual(encodeHP97SEntry("34.27").codes, [3, 4, 10, 2, 7, 15]);
  const entry = encodeHP97SEntry("1x2sean");
  assert.deepEqual(entry.codes, [1, 11, 2, 14, 12, 13, 15]);
  assert.equal(entry.runsProgram, true);
  assert.equal(entry.text, "1X2SEA");
  assert.equal(entry.labels.at(-2), "Run A");
  assert.equal(Object.isFrozen(entry.codes), true);
  assert.equal(encodeHP97SEntry("123456789N").codes.length, 10);
});

test("HP-97S rejects empty, overlong, malformed and truncated-after-Run-A entries", () => {
  for (const input of ["", "N", "NN", "1N2", "1234567890", "1234567890N", "1 2", "-3", "1\n", "A1", "AA", "1,2", "１", "0xF0"]) {
    assert.throws(() => encodeHP97SEntry(input), Error, input);
  }
  assert.deepEqual(encodeHP97SEntry("0").codes, [0, 15]);
});

test("HP-97S decodes Ready, changed and all four flags without misclassifying acknowledgements", () => {
  const status = decodeHP97SStatus(0x9A);
  assert.equal(status.ready, true);
  assert.equal(status.changed, true);
  assert.deepEqual(status.flags, [false, true, false, true]);
  assert.equal(decodeHP97SStatus(0).ready, false);
  for (const byte of [0xFF, 0xF1, 0xA0, 0xA1, 0xA2, 0x20, -1, 256, 1.5]) assert.throws(() => decodeHP97SStatus(byte));
});

test("HP-97S reproduces the documented 34.27 exchange and confirmed mode exit", async () => {
  const pairs = [[0x12, 0xFF], [0xF0, 0x10], [0xF1, 0xF1], [3, 0xF1], [4, 0xF1], [10, 0xF1], [2, 0xF1], [7, 0xF1], [15, 0xA0], [0xF5, 0xF5]];
  const { controller, sent } = scripted(pairs);
  await controller.enter();
  assert.equal(controller.blocksNormalCommands, true);
  await controller.send("34.27");
  assert.equal(controller.lastAccepted.text, "34.27");
  assert.equal(controller.status, null, "Do not retain readiness after key entry");
  await controller.leave();
  assert.equal(controller.mode, "off");
  assert.equal(controller.blocksNormalCommands, false);
  assert.deepEqual(sent, pairs.map(pair => pair[0]));
});

test("HP-97S waits for each acknowledgement and rejects concurrent operations", async () => {
  const { controller, sent } = harness();
  const enter = controller.enter();
  assert.deepEqual(sent, [0x12]);
  await assert.rejects(controller.readStatus(), /already in progress/);
  controller.receive([0xFF]);
  await enter;
  const sending = controller.send("2");
  assert.deepEqual(sent, [0x12, 0xF0]);
  controller.receive([0x10]);
  await tick();
  assert.deepEqual(sent, [0x12, 0xF0, 0xF1]);
  await assert.rejects(controller.leave(), /already in progress/);
  controller.receive([0xF1]);
  await tick();
  assert.equal(sent.at(-1), 2);
  controller.receive([0xF1]);
  await tick();
  assert.equal(sent.at(-1), 15);
  controller.receive([0xA0]);
  await sending;
  controller.close();
});

test("HP-97S rejected mode entry leaves ordinary commands available and can be tried again", async () => {
  const { controller, sent } = scripted([[0x12, 0], [0x12, 0xFF]]);
  await assert.rejects(controller.enter(), /RUN/);
  assert.equal(controller.mode, "off");
  assert.equal(controller.blocksNormalCommands, false);
  await controller.enter();
  assert.deepEqual(sent, [0x12, 0x12]);
  controller.close();
});

test("HP-97S explains the logged F5 entry rejection without assuming ON or confirmed OFF", async () => {
  const { controller, sent } = scripted([[0x12, 0xF5]]);
  await assert.rejects(controller.enter(), /F5.*separate 97S mode.*No keys were sent/);
  assert.equal(controller.mode, "fault");
  assert.equal(controller.blocksNormalCommands, true);
  assert.equal(controller.status, null);
  await assert.rejects(controller.enter());
  await assert.rejects(controller.readStatus());
  await assert.rejects(controller.send("3"));
  await assert.rejects(controller.leave());
  assert.deepEqual(sent, [0x12], "Do not guess an exit command or probe the external-equipment mode");
});

test("HP-97S handles the live FF entry followed by F5 status reply without sending keys or guessing OFF", async () => {
  for (const action of [controller => controller.readStatus(), controller => controller.send("34.27")]) {
    const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0xF5]]);
    await controller.enter();
    assert.equal(controller.mode, "on");
    await assert.rejects(action(controller), /entry was acknowledged.*status query returned F5.*wired PC connection/);
    assert.equal(controller.mode, "fault");
    assert.equal(controller.blocksNormalCommands, true);
    assert.equal(controller.status, null);
    assert.equal(controller.lastAccepted, null);
    await assert.rejects(controller.readStatus());
    await assert.rejects(controller.send("1"));
    await assert.rejects(controller.leave());
    assert.deepEqual(sent, [0x12, 0xF0], "No transfer request, key, retry or guessed exit follows F5");
  }
});

test("HP-97S firmware-21 Run A acceptance ends the transfer without a trailing NOP", async () => {
  const pairs = [[0x12, 0xFF], [0xF0, 0x10], [0xF1, 0xF1], [1, 0xF1], [1, 0xF1], [13, 0xA0], [0xF0, 0x00], [0xF5, 0xF5]];
  const { controller, sent } = scripted(pairs);
  await controller.enter();
  await controller.send("11A");
  assert.equal(controller.lastAccepted.text, "11A");
  assert.equal(controller.mode, "on");
  assert.equal(controller.status, null);
  assert.equal(sent.includes(15), false);
  assert.equal((await controller.readStatus()).ready, false);
  await controller.leave();
  assert.deepEqual(sent, pairs.map(pair => pair[0]));
});

test("HP-97S sends the final NOP after Run A only if the calculator prompts for it", async () => {
  const pairs = [[0x12, 0xFF], [0xF0, 0x10], [0xF1, 0xF1], [13, 0xF1], [15, 0xA0]];
  const { controller, sent } = scripted(pairs);
  await controller.enter();
  await controller.send("A");
  assert.equal(controller.lastAccepted.text, "A");
  assert.deepEqual(sent, pairs.map(pair => pair[0]));
  controller.close();
});

test("HP-97S freshly checks readiness and sends no keys when not ready", async () => {
  const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0x10], [0xF0, 0x08]]);
  await controller.enter();
  assert.equal((await controller.readStatus()).ready, true);
  await assert.rejects(controller.send("3"), /not ready/);
  assert.deepEqual(sent, [0x12, 0xF0, 0xF0]);
  assert.equal(controller.mode, "on");
  assert.equal(controller.lastAccepted, null);
  controller.close();
});

test("HP-97S validates input before sending any commands", async () => {
  const { controller, sent } = scripted([[0x12, 0xFF]]);
  await assert.rejects(controller.send("1"), /Turn on/);
  await controller.enter();
  await assert.rejects(controller.send("1234567890"), /at most nine/);
  assert.deepEqual(sent, [0x12]);
  controller.close();
});

test("HP-97S idle notifications update flags; control bytes are never treated as flags", async () => {
  const { controller } = scripted([[0x12, 0xFF]]);
  await controller.enter();
  controller.receive([0x91, 0x88]);
  assert.equal(controller.status.ready, false);
  assert.deepEqual(controller.status.flags, [false, false, false, true]);
  controller.receive([0xF1]);
  assert.equal(controller.mode, "fault");
  assert.equal(controller.status, null);
});

test("HP-97S A1, A2, early A0 and unknown replies stop mid-entry with no retry or trailing bytes", async () => {
  for (const failure of [0xA1, 0xA2, 0xA0, 0x42]) {
    const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0x10], [0xF1, 0xF1], [1, failure]]);
    await controller.enter();
    await assert.rejects(controller.send("123"));
    assert.equal(controller.mode, "fault");
    assert.equal(controller.lastAccepted, null);
    await assert.rejects(controller.send("123"));
    await assert.rejects(controller.leave());
    assert.deepEqual(sent, [0x12, 0xF0, 0xF1, 1]);
  }
});

test("HP-97S refuses digit data without the initial F1 permission", async () => {
  const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0x10], [0xF1, 0x00]]);
  await controller.enter();
  await assert.rejects(controller.send("9"));
  assert.deepEqual(sent, [0x12, 0xF0, 0xF1]);
  assert.equal(controller.mode, "fault");
});

test("HP-97S requires A0 after the terminator before claiming acceptance", async () => {
  const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0x10], [0xF1, 0xF1], [9, 0xF1], [15, 0xF1]]);
  await controller.enter();
  await assert.rejects(controller.send("9"));
  assert.equal(controller.lastAccepted, null);
  assert.deepEqual(sent, [0x12, 0xF0, 0xF1, 9, 15]);
});

test("HP-97S stops for unverified interleaved flag notifications or coalesced extra replies", async () => {
  for (const reply of [[0x91], [0xF1, 0x91], [0xF1, 0xF1]]) {
    const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0x10], [0xF1, reply]]);
    await controller.enter();
    await assert.rejects(controller.send("3"));
    assert.equal(controller.mode, "fault");
    assert.deepEqual(sent, [0x12, 0xF0, 0xF1]);
  }
});

test("HP-97S timeout retains the recovery lock and never retries", async () => {
  const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0x10], [0xF1, undefined]], { digitTimeoutMs: 15 });
  await controller.enter();
  await assert.rejects(controller.send("5"), /Timed out/);
  assert.equal(controller.blocksNormalCommands, true);
  await assert.rejects(controller.readStatus());
  assert.deepEqual(sent, [0x12, 0xF0, 0xF1]);
});

test("HP-97S failed mode entry or exit never reports a confirmed off state", async () => {
  const first = scripted([[0x12, undefined]], { timeoutMs: 15 });
  await assert.rejects(first.controller.enter(), /Timed out/);
  assert.equal(first.controller.mode, "fault");
  const second = scripted([[0x12, 0xFF], [0xF5, 0x00]]);
  await second.controller.enter();
  await assert.rejects(second.controller.leave());
  assert.equal(second.controller.blocksNormalCommands, true);
});

test("HP-97S transport errors stop the exchange, including synchronous write failures", async () => {
  for (const write of [() => { throw new Error("offline"); }, () => Promise.reject(new Error("offline"))]) {
    const controller = new HP97SController({ write });
    await assert.rejects(controller.enter(), /offline/);
    assert.equal(controller.mode, "fault");
    assert.equal(controller.waiter, null);
  }
});

test("HP-97S disconnect rejects an in-flight transfer and ignores late replies", async () => {
  const { controller, sent } = scripted([[0x12, 0xFF], [0xF0, 0x10], [0xF1, 0xF1], [1, undefined]]);
  await controller.enter();
  const sending = controller.send("123");
  const failure = assert.rejects(sending, /Connection lost/);
  await tick();
  assert.equal(controller.close(), true);
  controller.receive([0xF1]);
  await failure;
  await assert.rejects(controller.enter(), /closed/);
  assert.deepEqual(sent, [0x12, 0xF0, 0xF1, 1]);
});

test("HP-97S handles synchronous replies and the maximum conservative nine-key transfer", async () => {
  const peer = new DemoHP97SDevice();
  let controller;
  controller = new HP97SController({ write: bytes => controller.receive(peer.write(bytes)) });
  await controller.enter();
  await controller.send("123456789");
  assert.deepEqual(peer.lastKeys, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal((await controller.readStatus()).ready, false);
  controller.receive(peer.toggleFlag(3));
  assert.equal(controller.status.ready, true);
  controller.receive(peer.toggleFlag(2));
  await controller.send("11A");
  assert.deepEqual(peer.lastKeys, [1, 1, 13]);
  assert.deepEqual((await controller.readStatus()).flags, [false, false, true, false]);
  await controller.leave();
  assert.equal(peer.active, false);
  assert.equal(controller.close(), false);
});
