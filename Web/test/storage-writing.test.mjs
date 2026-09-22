import test from "node:test";
import assert from "node:assert/strict";
import { StoredSlotWriteTransfer, demoStoredSlot, makeStoredCapture, loadStoredCapture,
  encodeStoredCapture, demoDirectory, writeDemoSlot } from "../stored-programs.js";
import { writeBackedUpSlot, saveBackupFile } from "../storage-writing.js";

const sourceBytes = demoStoredSlot(0, 0);

test("writer addresses the chosen slot in BCD and requires acknowledgements through commit and finish", () => {
  const bytes = sourceBytes.slice();
  const transfer = new StoredSlotWriteTransfer(14, 49, bytes);
  bytes.fill(0); // Its private source cannot be changed while writing.
  const receive = byte => transfer.append(Uint8Array.of(byte));
  assert.deepEqual([...receive(4).packets[0]], [0x55]);
  assert.deepEqual([...receive(0x55).packets[0]], [14, 0x49]);
  for (let offset = 0; offset < 150; offset += 10) {
    assert.deepEqual([...receive(4).packets[0]], [0, ...sourceBytes.slice(offset, offset + 10)]);
    assert.equal(transfer.committed, false);
  }
  assert.deepEqual([...receive(4).packets[0]], [0xaa]);
  assert.equal(transfer.committed, true);
  const finish = receive(4);
  assert.deepEqual([...finish.packets[0]], [0xff]);
  assert.equal(finish.complete, false);
  assert.equal(receive(4).complete, true);
  assert.throws(() => receive(4), /acknowledgement/);
});

test("writer rejects errors, unexpected and excess replies at every stage before advancing", () => {
  const expectedReplies = [4, 0x55, ...Array(18).fill(4)];
  for (let stage = 0; stage < expectedReplies.length; stage += 1) {
    for (const invalid of [[0xae], [7], [4, 4], []]) {
      const transfer = new StoredSlotWriteTransfer(8, 50, sourceBytes);
      expectedReplies.slice(0, stage).forEach(byte => transfer.append(Uint8Array.of(byte)));
      const phase = transfer.phase;
      assert.throws(() => transfer.append(Uint8Array.from(invalid)));
      assert.equal(transfer.phase, phase);
    }
  }
  assert.throws(() => new StoredSlotWriteTransfer(15, 0, sourceBytes));
  assert.throws(() => new StoredSlotWriteTransfer(0, 54, sourceBytes));
});

async function scenario(overrides = {}) {
  const calls = [];
  let destination = new Uint8Array(150).fill(0xff);
  const source = await makeStoredCapture(0, 0, sourceBytes, false);
  const options = {
    source, block: 8, slot: 49, simulated: false,
    read: async (block, slot) => { calls.push(["read", block, slot]); return destination.slice(); },
    write: async (block, slot, bytes) => { calls.push(["write", block, slot]); destination = bytes.slice(); },
    saveBackup: async text => { calls.push(["backup"]); return text; },
    ...overrides,
  };
  return { options, calls, source };
}

test("fresh backup is checked before writing and a separate read verifies the entire destination", async () => {
  const { options, calls, source } = await scenario();
  const result = await writeBackedUpSlot(options);
  assert.deepEqual(calls, [["read", 8, 49], ["backup"], ["write", 8, 49], ["read", 8, 49]]);
  assert.ok(result.backup.bytes.every(byte => byte === 0xff));
  assert.equal(result.backup.slot, 49);
  assert.deepEqual(result.capture.bytes, source.bytes);
  assert.equal(result.capture.sha256, source.sha256);
});

test("backup cancellation, save errors, damage, or a different valid backup prevent all writes", async () => {
  const wrong = await makeStoredCapture(8, 48, new Uint8Array(150).fill(0xff));
  const wrongBytes = await makeStoredCapture(8, 49, sourceBytes);
  for (const saveBackup of [
    async () => { throw new DOMException("Cancelled", "AbortError"); },
    async () => { throw new Error("Disk full"); },
    async () => "damaged",
    async () => encodeStoredCapture(wrong),
    async () => encodeStoredCapture(wrongBytes),
  ]) {
    const { options, calls } = await scenario({ saveBackup });
    await assert.rejects(writeBackedUpSlot(options));
    assert.deepEqual(calls, [["read", 8, 49]]);
  }
});

test("invalid or Demo source cannot touch a live slot", async () => {
  for (const edit of [source => { source.simulated = true; }, source => { source.bytes[40] ^= 1; }, source => { source.sha256 = "bad"; }]) {
    const { options, calls, source } = await scenario();
    edit(source);
    await assert.rejects(writeBackedUpSlot(options));
    assert.deepEqual(calls, []);
  }
});

test("disconnect during backup saving prevents a write and source edits cannot alter frozen bytes", async () => {
  let connected = true;
  const { options, calls } = await scenario({
    ensureConnected: () => { if (!connected) throw new Error("Disconnected"); },
    saveBackup: async text => { connected = false; return text; },
  });
  await assert.rejects(writeBackedUpSlot(options), /Disconnected/);
  assert.deepEqual(calls, [["read", 8, 49]]);
  const second = await scenario();
  second.options.onBackup = () => { second.source.bytes.fill(0); second.source.sha256 = "changed"; };
  assert.deepEqual((await writeBackedUpSlot(second.options)).capture.bytes, sourceBytes);
});

test("failed writes and mismatched read-back never retry and retain the original backup", async () => {
  for (const kind of ["write failure", "read failure", "mismatch"]) {
    let reads = 0;
    let writes = 0;
    let backup;
    const before = demoStoredSlot(0, 1);
    const { options } = await scenario({
      read: async () => {
        reads += 1;
        if (reads === 1) return before;
        if (kind === "read failure") throw new Error("Read timed out");
        const wrong = sourceBytes.slice(); wrong[149] = 0;
        return wrong;
      },
      onBackup: capture => { backup = capture; },
      write: async () => { writes += 1; if (kind === "write failure") throw new Error("Ack timed out"); },
    });
    await assert.rejects(writeBackedUpSlot(options));
    assert.equal(writes, 1);
    assert.deepEqual(backup.bytes, before);
  }
});

test("file backup closes and reopens disk contents and aborts failed writes", async () => {
  const calls = [];
  let disk;
  const handle = {
    createWritable: async () => ({
      write: async text => { calls.push("write"); disk = text; },
      close: async () => { calls.push("close"); },
      abort: async () => { calls.push("abort"); },
    }),
    getFile: async () => { calls.push("reopen"); return { text: async () => disk }; },
  };
  const text = encodeStoredCapture(await makeStoredCapture(8, 49, sourceBytes));
  assert.deepEqual((await loadStoredCapture(await saveBackupFile(handle, text))).bytes, sourceBytes);
  assert.deepEqual(calls, ["write", "close", "reopen"]);
  handle.createWritable = async () => ({ write: async () => { throw new Error("Disk full"); }, abort: async () => { calls.push("abort"); } });
  await assert.rejects(saveBackupFile(handle, text), /Disk full/);
  assert.equal(calls.at(-1), "abort");
});

test("Demo write updates only its destination and can be independently read back", async () => {
  const source = await makeStoredCapture(0, 0, sourceBytes, true);
  const result = await writeBackedUpSlot({ source, block: 14, slot: 51, simulated: true,
    read: demoStoredSlot, write: writeDemoSlot, saveBackup: async text => text });
  assert.equal(result.backup.simulated, true);
  assert.ok(result.backup.bytes.every(byte => byte === 0xff));
  assert.deepEqual(demoStoredSlot(14, 51), sourceBytes);
  assert.equal(demoDirectory(14)[51].name, source.name);
  assert.ok(demoStoredSlot(14, 50).every(byte => byte === 0xff));
});
