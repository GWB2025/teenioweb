import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ClockReadTransfer,
  ClockWriteTransfer,
  RAMReadTransfer,
  clockSettingPackets,
  decodeClock,
  decodeRAM,
  demoRAM,
  registerNumber,
} from "../calculator.js";

function bytesFromFixture() {
  const text = readFileSync(new URL("../../Tests/Fixtures/HP97-active-memory.txt", import.meta.url), "utf8");
  const rows = text.split(/\r?\n/).filter(line => /^[0-9A-F]{2}\s+(?:[0-9A-F]{2}\s*){7}$/.test(line));
  assert.equal(rows.length, 64);
  return Uint8Array.from(rows.flatMap(line => line.trim().split(/\s+/).slice(1).map(value => Number.parseInt(value, 16))));
}

test("clock reader handles the captured two-block firmware exchange", () => {
  const transfer = new ClockReadTransfer();
  assert.deepEqual([...transfer.append(Uint8Array.of(0x0f)).packets[0]], [0x01]);
  assert.deepEqual([...transfer.append(Uint8Array.of(0x01)).packets[0]], [0x01]);
  const raw = Uint8Array.of(0x08, 0x03, 0x15, 0x03, 0x22, 0x09, 0x26, 0x00, 0, 0, 0, 0, 0, 0, 0x1c, 0xff);
  const first = transfer.append(raw.slice(0, 8));
  assert.deepEqual([...first.packets[0]], [0x01]);
  const second = transfer.append(raw.slice(8));
  assert.deepEqual([...second.packets[0]], [0x00]);
  const done = transfer.append(Uint8Array.of(0x00));
  assert.equal(done.complete, true);
  assert.equal(done.result.date.getFullYear(), 2026);
  assert.equal(done.result.date.getMonth(), 8);
  assert.equal(done.result.date.getDate(), 22);
  assert.equal(done.result.date.getHours(), 15);
  assert.equal(done.result.date.getMinutes(), 3);
  assert.equal(done.result.date.getSeconds(), 8);
});

test("clock reader accepts byte-by-byte clock data", () => {
  const transfer = new ClockReadTransfer();
  const transcript = [0x0f, 0x01, 0x08, 0x03, 0x15, 0x03, 0x22, 0x09, 0x26, 0, 0, 0, 0, 0, 0, 0, 0x1c, 0xff, 0];
  let result;
  for (const byte of transcript) result = transfer.append(Uint8Array.of(byte));
  assert.equal(result.complete, true);
});

test("clock writer produces the physically verified framed packets", () => {
  const date = new Date(2026, 8, 22, 15, 17, 0);
  const packets = clockSettingPackets(date);
  assert.deepEqual([...packets[0]], [0, 0, 3, 0, 0x17, 0x15]);
  assert.deepEqual([...packets[1]], [0, 3, 4, 3, 0x22, 0x09, 0x26]);
  const transfer = new ClockWriteTransfer(date);
  assert.deepEqual([...transfer.append(Uint8Array.of(0x0f)).packets[0]], [0]);
  assert.deepEqual([...transfer.append(Uint8Array.of(0)).packets[0]], [...packets[0]]);
  assert.deepEqual([...transfer.append(Uint8Array.of(0)).packets[0]], [...packets[1]]);
  assert.deepEqual([...transfer.append(Uint8Array.of(0)).packets[0]], [1]);
  assert.equal(transfer.append(Uint8Array.of(1)).complete, true);
});

test("RAM reader reconstructs all 448 bytes under fragmented delivery", () => {
  const expected = bytesFromFixture();
  const transfer = new RAMReadTransfer();
  assert.deepEqual([...transfer.append(Uint8Array.of(0x0c)).packets[0]], [0xaa]);
  for (let register = 0; register < 64; register += 1) {
    const frame = Uint8Array.of(0xaa, ...expected.slice(register * 7, register * 7 + 7));
    let update;
    for (const byte of frame) update = transfer.append(Uint8Array.of(byte));
    assert.deepEqual([...update.packets[0]], [register === 63 ? 0x55 : 0xaa]);
  }
  const done = transfer.append(Uint8Array.of(0x0c));
  assert.equal(done.complete, true);
  assert.deepEqual(done.result.bytes, expected);
  assert.equal(done.result.registers.length, 16);
  assert.equal(done.result.program.length, 224);
});

test("RAM decoding preserves physical program order and table alignment", () => {
  const reading = decodeRAM(bytesFromFixture());
  assert.equal(reading.program.length, 224);
  assert.equal(reading.program[0].ramAddress, 0x2f);
  assert.equal(reading.program[6].byteOffset, 6);
  assert.equal(reading.program[7].ramAddress, 0x2e);
  assert.equal(reading.program[0].instruction.length > 0, true);
  assert.equal(reading.rows.length, 64);
});

test("register decoder and Demo capture retain sixteen registers", () => {
  assert.equal(registerNumber(Uint8Array.of(0, 0, 0, 0, 0, 0, 0)), "0");
  const reading = demoRAM();
  assert.equal(reading.bytes.length, 448);
  assert.equal(reading.registers.length, 16);
  assert.equal(reading.simulated, true);
});

test("invalid calendar data is rejected", () => {
  assert.throws(() => decodeClock(Uint8Array.of(0, 0, 0, 0, 0x31, 0x02, 0x26, 0, 0, 0, 0, 0, 0, 0, 0, 0)));
});
