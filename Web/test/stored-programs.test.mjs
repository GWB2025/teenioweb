import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DirectoryTransfer,
  StoredSlotReadTransfer,
  decodeHPP,
  demoDirectory,
  demoStoredSlot,
  encodeHPP,
  encodeStoredCapture,
  loadStoredCapture,
  makeStoredCapture,
  validateProgramCard,
} from "../stored-programs.js";

const fixture = new URL("../../Tests/Fixtures/HP97-stored-slot-0-00.bin", import.meta.url);
const hppFixture = new URL("../../Programs/Lucas-Lehmer-HP97.hpp", import.meta.url);

test("directory transfer reconstructs all 54 entries under fragmentation", () => {
  const transfer = new DirectoryTransfer(14);
  assert.deepEqual(Array.from(transfer.append(Uint8Array.of(0x06)).packets[0]), [0x0e, 0x00]);
  assert.deepEqual(Array.from(transfer.append(Uint8Array.of(0x06)).packets[0]), [0x00]);
  const record = Uint8Array.from([0x43, ...new TextEncoder().encode("TEST"), ...Array(16).fill(0xff), ...Array(7).fill(0)]);
  assert.deepEqual(Array.from(transfer.append(Uint8Array.of(0x06)).packets[0]), [0x06]);
  assert.equal(transfer.append(record.slice(0, 9)).packets.length, 0);
  assert.deepEqual(Array.from(transfer.append(record.slice(9)).packets[0]), [0x06]);
  for (let slot = 1; slot < 54; slot += 1) {
    assert.deepEqual(Array.from(transfer.append(Uint8Array.of(0x06)).packets[0]), [0x00]);
    transfer.append(Uint8Array.of(0xff));
  }
  const result = transfer.append(Uint8Array.of(0x06));
  assert.equal(result.complete, true);
  assert.equal(result.result.length, 54);
  assert.equal(result.result[0].name, "TEST");
  assert.equal(result.result[53], null);
});

test("stored-slot reader accepts every split in each ten-byte block", () => {
  const payload = Uint8Array.from({ length: 150 }, (_, index) => index);
  for (let split = 0; split <= 10; split += 1) {
    const transfer = new StoredSlotReadTransfer(14, 53);
    assert.deepEqual(Array.from(transfer.append(Uint8Array.of(3)).packets[0]), [14, 0x53]);
    assert.deepEqual(Array.from(transfer.append(Uint8Array.of(3)).packets[0]), [0xee]);
    for (let offset = 0; offset < 150; offset += 10) {
      const first = transfer.append(payload.slice(offset, offset + split));
      const second = transfer.append(payload.slice(offset + split, offset + 10));
      const packets = [...first.packets, ...second.packets];
      assert.deepEqual(Array.from(packets[0]), [offset === 140 ? 0xff : 0xee]);
    }
    const result = transfer.append(Uint8Array.of(3));
    assert.equal(result.complete, true);
    assert.deepEqual(result.result, payload);
  }
});

test("web capture is compatible with the native stored-slot format", async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  const capture = await makeStoredCapture(14, 53, bytes, false, new Date("2026-09-22T12:00:00Z"));
  const reopened = await loadStoredCapture(encodeStoredCapture(capture));
  assert.equal(reopened.block, 14);
  assert.equal(reopened.slot, 53);
  assert.deepEqual(reopened.bytes, bytes);
  assert.equal(reopened.capturedAt.toISOString(), "2026-09-22T12:00:00.000Z");
  const damaged = JSON.parse(encodeStoredCapture(capture));
  damaged.sha256 = "bad";
  await assert.rejects(() => loadStoredCapture(JSON.stringify(damaged)), /integrity/);
});

test("physical card and HPP survive exact validation and round trip", async () => {
  const card = new Uint8Array(await readFile(fixture));
  assert.equal(validateProgramCard(card).name, "Sd1_01A_1 _o_ing A_E");
  const hpp = new Uint8Array(await readFile(hppFixture));
  const decoded = decodeHPP(hpp);
  assert.equal(decoded.name, "LUCAS LEHMER V2");
  assert.deepEqual(encodeHPP(decoded.record), hpp);
});

test("Demo directory and slot use a checksum-valid HP-97 card", () => {
  const directory = demoDirectory(0);
  assert.equal(directory.length, 54);
  assert.equal(directory[0].name, "Example calculation");
  assert.equal(directory[2], null);
  assert.equal(validateProgramCard(demoStoredSlot(0, 0)).name, "Example calculation");
  assert.ok(Array.from(demoStoredSlot(14, 53)).every(byte => byte === 0xff));
});

test("actual TEENIX97 marker-61 capture exports the exact title and card body", async () => {
  const actual = new Uint8Array(await readFile(new URL("../../Tests/Fixtures/HP97-stored-slot-8-49.bin", import.meta.url)));
  const original = decodeHPP(new Uint8Array(await readFile(new URL("../../Programs/Lucas-Lehmer-Extended-HP97-card-1.hpp", import.meta.url)))).record;
  assert.equal(actual[0], 0x61);
  assert.equal(validateProgramCard(actual).name, "LUCAS LEH_Er _1_1");
  assert.deepEqual(actual.slice(21), original.slice(21));
  const reopened = decodeHPP(encodeHPP(actual)).record;
  assert.equal(reopened[0], 0x43);
  assert.deepEqual(reopened.slice(1), actual.slice(1));
  assert.equal(actual[0], 0x61, "export must not mutate the original capture");
  const saved = await makeStoredCapture(8, 49, actual);
  assert.equal(saved.sha256, "5f2a0289f994186eea66284a15044d1d374b6f468ea9b47c4a4fc4851ef8e4eb");
  assert.deepEqual((await loadStoredCapture(encodeStoredCapture(saved))).bytes, actual);
});

test("recognising marker 61 does not weaken title, model, padding or checksum validation", () => {
  const original = demoStoredSlot(0, 0);
  for (const [offset, byte] of [[0, 0x62], [2, 0xff], [30, 0x55], [140, 0x00]]) {
    const damaged = original.slice();
    damaged[offset] = byte;
    assert.throws(() => validateProgramCard(damaged));
    assert.throws(() => encodeHPP(damaged));
  }
  assert.throws(() => validateProgramCard(new Uint8Array(150).fill(0xff)), /vacant/);
  const spaced = original.slice();
  spaced.fill(0xff, 1, 21);
  spaced.set(new TextEncoder().encode(" PADDED "), 1);
  assert.deepEqual(decodeHPP(encodeHPP(spaced)).record, spaced);
});

test("capture import rejects ambiguous Demo provenance and invalid metadata", async () => {
  const saved = JSON.parse(encodeStoredCapture(await makeStoredCapture(0, 0, demoStoredSlot(0, 0), true)));
  for (const simulated of [undefined, "false", 0, null]) {
    await assert.rejects(loadStoredCapture(JSON.stringify({ ...saved, simulated })), /metadata/);
  }
  await assert.rejects(loadStoredCapture("null"), /metadata/);
});
