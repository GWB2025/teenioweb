import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeRAM, demoRAM, memoryReport } from "../calculator.js";
import { prepareMemoryCards, loadMemoryReport } from "../memory-cards.js";
import { demoStoredSlot, loadStoredCapture, encodeStoredCapture } from "../stored-programs.js";
import { compareLoadedProgram, encodeProgramBackup, loadProgramBackup, programBytesFromCards, uploadProgramPair } from "../program-upload.js";

const source = loadMemoryReport(await readFile(new URL("../../Tests/Fixtures/HP97-active-memory.txt", import.meta.url), "utf8"));
const template = { bytes: demoStoredSlot(0, 0), simulated: false };
function scenario(overrides = {}) {
  const memory = { ...source, bytes: source.bytes.slice() };
  const cards = prepareMemoryCards(memory, template, "Upload test");
  const before = { ...demoRAM(), simulated: false };
  const destinations = new Map([[49, new Uint8Array(150).fill(0xff)], [50, demoStoredSlot(0, 1)]]);
  const calls = [];
  let backup;
  const options = { cards, memory, block: 8, slot: 49, simulated: false,
    readMemory: async () => { calls.push("RAM"); return before; },
    readSlot: async (_, slot) => { calls.push(`read ${slot}`); return destinations.get(slot).slice(); },
    writeSlot: async (_, slot, bytes) => { calls.push(`write ${slot}`); destinations.set(slot, bytes.slice()); },
    saveBackup: async text => { calls.push("save/reopen"); return text; },
    onBackup: value => { backup = value; }, ...overrides,
  };
  return { options, calls, before, destinations, backup: () => backup };
}

test("both slots and active RAM are backed up before writing either card; each card has independent read-back", async () => {
  const check = scenario();
  const before = check.before.bytes.slice();
  const result = await uploadProgramPair(check.options);
  assert.deepEqual(check.calls, ["RAM", "read 49", "read 50", "save/reopen", "write 49", "read 49", "write 50", "read 50"]);
  assert.deepEqual(check.before.bytes, before, "Upload must not load the active program");
  assert.deepEqual(result.expectedProgram, source.bytes.slice(112, 336));
  assert.deepEqual(programBytesFromCards(result.cards), source.bytes.slice(112, 336));
  assert.ok(result.backup.slots[0].bytes.every(byte => byte === 0xff));
  assert.deepEqual(result.backup.slots[1].bytes, demoStoredSlot(0, 1));
});

test("saved bundle reopens as native-compatible slot captures and an exact active-memory report", async () => {
  const result = await uploadProgramPair(scenario().options);
  const reopened = await loadProgramBackup(encodeProgramBackup(result.backup));
  assert.deepEqual(reopened.memory.bytes, result.before);
  assert.deepEqual(loadMemoryReport(memoryReport(reopened.memory)).bytes, result.before);
  for (const slot of reopened.slots) assert.deepEqual((await loadStoredCapture(encodeStoredCapture(slot))).bytes, slot.bytes);
  assert.equal(encodeProgramBackup(reopened), encodeProgramBackup(result.backup));
});

test("invalid destinations, source mismatch, reversed/single cards and Demo provenance are rejected before IO", async () => {
  for (const mutate of [
    o => { o.slot = 53; }, o => { o.block = 15; }, o => { o.slot = -1; }, o => { o.slot = 1.5; },
    o => { o.cards.reverse(); }, o => { o.cards.pop(); }, o => { o.cards[1].record = template.bytes; },
    o => { o.memory.bytes[150] ^= 1; }, o => { o.cards[0].record[50] ^= 1; },
    o => { o.memory.simulated = true; }, o => { o.cards[1].simulated = true; },
    o => { o.cards[1].simulated = undefined; },
  ]) {
    const check = scenario(); mutate(check.options);
    await assert.rejects(uploadProgramPair(check.options));
    assert.deepEqual(check.calls, []);
  }
});

test("slot 52 is the final valid starting slot and never rolls into the next block", async () => {
  const check = scenario({ block: 14, slot: 52 });
  check.destinations.set(52, new Uint8Array(150).fill(0xff));
  check.destinations.set(53, new Uint8Array(150).fill(0xff));
  const result = await uploadProgramPair(check.options);
  assert.deepEqual(result.backup.slots.map(slot => [slot.block, slot.slot]), [[14, 52], [14, 53]]);
  assert.deepEqual(check.calls.filter(call => call.startsWith("write")), ["write 52", "write 53"]);
});

test("incomplete RAM or either failed slot backup prevents all writing", async () => {
  for (const stage of ["ram", "first", "second", "wrong mode"]) {
    const check = scenario();
    if (stage === "ram") check.options.readMemory = async () => ({ ...check.before, bytes: new Uint8Array(447) });
    else if (stage === "wrong mode") check.before.simulated = true;
    else check.options.readSlot = async (_, slot) => {
      if (slot === (stage === "first" ? 49 : 50)) throw new Error("Backup read failed");
      return new Uint8Array(150).fill(0xff);
    };
    await assert.rejects(uploadProgramPair(check.options));
    assert.ok(!check.calls.some(call => call.startsWith("write") || call === "save/reopen"));
  }
});

test("cancelled, failed, corrupt, or different valid disk backup prevents either write", async () => {
  const other = await uploadProgramPair(scenario().options);
  for (const saveBackup of [
    async () => { throw new DOMException("Cancelled", "AbortError"); },
    async () => { throw new Error("Disk full"); }, async () => "invalid JSON",
    async text => { const json = JSON.parse(text); json.memory.sha256 = "bad"; return JSON.stringify(json); },
    async text => { const json = JSON.parse(text); json.slots.reverse(); return JSON.stringify(json); },
    async text => { const json = JSON.parse(text); json.simulated = true; return JSON.stringify(json); },
    async () => encodeProgramBackup(other.backup),
  ]) {
    const check = scenario({ saveBackup });
    check.before.bytes[0] = 1; // A different valid backup must still fail comparison.
    await assert.rejects(uploadProgramPair(check.options));
    assert.deepEqual(check.calls, ["RAM", "read 49", "read 50"]);
  }
});

test("disconnection during backup saving prevents writing and retains both captures", async () => {
  let connected = true;
  const check = scenario({ ensureConnected: () => { if (!connected) throw new Error("Disconnected"); },
    saveBackup: async text => { connected = false; return text; } });
  await assert.rejects(uploadProgramPair(check.options), /Disconnected/);
  assert.equal(check.backup().slots.length, 2);
  assert.deepEqual(check.calls, ["RAM", "read 49", "read 50"]);
});

test("source or UI backup edits cannot change frozen card bytes, expected program, or disk backup", async () => {
  const check = scenario();
  const original = check.options.cards.map(card => card.record.slice());
  check.options.onBackup = backup => {
    check.options.cards.forEach(card => card.record.fill(0));
    check.options.memory.bytes.fill(0);
    backup.memory.bytes.fill(0);
    backup.slots[0].bytes.fill(0);
  };
  const result = await uploadProgramPair(check.options);
  assert.deepEqual(result.cards, original);
  assert.deepEqual(result.expectedProgram, source.bytes.slice(112, 336));
  assert.ok(result.backup.slots[0].bytes.every(byte => byte === 0xff));
});

test("failure or mismatched read-back on either card stops without retries or restoring", async () => {
  for (const failedPart of [0, 1]) for (const failure of ["write", "read", "mismatch"]) {
    const check = scenario();
    const target = 49 + failedPart;
    const read = check.options.readSlot;
    const write = check.options.writeSlot;
    const writes = [];
    check.options.writeSlot = async (block, slot, bytes) => {
      writes.push(slot);
      if (slot === target && failure === "write") throw new Error("Write interrupted");
      await write(block, slot, bytes);
    };
    check.options.readSlot = async (block, slot) => {
      if (slot === target && writes.includes(slot)) {
        if (failure === "read") throw new Error("Read interrupted");
        if (failure === "mismatch") { const wrong = await read(block, slot); wrong[149] ^= 1; return wrong; }
      }
      return read(block, slot);
    };
    await assert.rejects(uploadProgramPair(check.options));
    assert.deepEqual(writes, failedPart ? [49, 50] : [49]);
    assert.ok(check.backup().slots[0].bytes.every(byte => byte === 0xff));
    assert.deepEqual(check.backup().memory.bytes, check.before.bytes);
  }
});

test("verification requires all 224 positions and all sixteen register bytes to match", () => {
  const before = demoRAM().bytes;
  const expected = source.bytes.slice(112, 336);
  const after = before.slice(); after.set(expected, 112);
  assert.equal(compareLoadedProgram(before, expected, after).verified, true);
  for (let index = 0; index < 224; index += 1) {
    const wrong = after.slice(); wrong[112 + index] ^= 1;
    const result = compareLoadedProgram(before, expected, wrong);
    assert.equal(result.programMatches, false);
    assert.equal(result.verified, false);
  }
  for (let index = 0; index < 112; index += 1) {
    const wrong = after.slice(); wrong[index] ^= 1;
    const result = compareLoadedProgram(before, expected, wrong);
    assert.equal(result.verified, false);
    assert.equal(result.changedRegisters.length, 1);
  }
  after[400] ^= 1; // Unrelated calculator state is deliberately not compared.
  assert.equal(compareLoadedProgram(before, expected, after).verified, true);
});

test("the already-active program never reports that loading has been verified", () => {
  const before = source.bytes;
  const result = compareLoadedProgram(before, before.slice(112, 336), before.slice());
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.verified, false);
  assert.match(result.message, /cannot confirm/);
  assert.throws(() => compareLoadedProgram(new Uint8Array(447), before.slice(112, 336), before));
});

test("Demo upload and simulated load remain separate and preserve numeric registers", async () => {
  const check = scenario({ simulated: true }); check.before.simulated = true;
  check.options.cards.forEach(card => { card.simulated = true; });
  const before = check.before.bytes.slice();
  const uploaded = await uploadProgramPair(check.options);
  assert.deepEqual(check.before.bytes, before);
  assert.equal(compareLoadedProgram(uploaded.before, uploaded.expectedProgram, check.before.bytes).programMatches, false);
  check.before.bytes.set(programBytesFromCards([check.destinations.get(49), check.destinations.get(50)]), 112);
  assert.deepEqual(check.before.bytes.slice(0, 112), before.slice(0, 112));
  assert.equal(compareLoadedProgram(uploaded.before, uploaded.expectedProgram, check.before.bytes).verified, true);
});
