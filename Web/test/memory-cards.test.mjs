import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadMemoryReport, prepareMemoryCards } from "../memory-cards.js";
import { decodeRAM, demoRAM, memoryReport, programReport } from "../calculator.js";
import { decodeHPP, demoStoredSlot, validateProgramCard } from "../stored-programs.js";

const report = await readFile(new URL("../../Tests/Fixtures/HP97-active-memory.txt", import.meta.url), "utf8");
const physical = new Uint8Array(await readFile(new URL("../../Tests/Fixtures/HP97-stored-slot-0-00.bin", import.meta.url)));
const template = { bytes: physical, simulated: false };

// Decode the on-card words independently into their ascending RAM addresses.
function copyCardToRAM(record, ram, highest) {
  const digits = Array.from(record.slice(21, 140)).flatMap(byte => [byte >> 4, byte & 15]);
  for (let register = 0; register < 16; register += 1) {
    const offset = 7 + register * 14;
    for (let index = 0; index < 14; index += 2) {
      ram[(highest - register) * 7 + index / 2] =
        digits[offset + (index + 7) % 14] * 16 + digits[offset + (index + 8) % 14];
    }
  }
}

test("memory import reopens native, Web and Demo reports with original time and provenance", () => {
  const native = loadMemoryReport(report);
  assert.equal(native.bytes.length, 448);
  assert.equal(native.registers.length, 16);
  assert.equal(native.program.length, 224);
  assert.equal(native.program[0].opcode, 0xea);
  assert.equal(native.simulated, false);
  assert.equal(native.capturedAt.toISOString(), "2026-09-17T17:51:50.000Z");
  assert.deepEqual(loadMemoryReport(memoryReport(native)).bytes, native.bytes);
  const demo = demoRAM();
  demo.capturedAt = new Date("2026-09-23T11:12:13.456Z");
  const reopened = loadMemoryReport("\uFEFF" + memoryReport(demo).replaceAll("\n", "\r\n"));
  assert.deepEqual(reopened.bytes, demo.bytes);
  assert.equal(reopened.simulated, true);
  assert.equal(reopened.capturedAt.getTime(), demo.capturedAt.getTime());
});

test("memory import rejects incomplete, duplicate, reordered and malformed RAM rows", () => {
  const badReports = [
    report.replace(/^3F .+\n/m, ""),
    report + "3F  00 11 22 00 00 00 09\n",
    report.replace(/^01  /m, "00  "),
    report.replace(/^00  30/m, "00  3G"),
    report.replace(/^00  30/m, "00  030"),
    report.replace(/^00  30/m, "00 "),
    report.replace(/^00  /m, "01  ").replace(/^01  50/m, "00  50"),
    report + "extra text",
    programReport(loadMemoryReport(report)),
  ];
  for (const value of badReports) assert.throws(() => loadMemoryReport(value), /complete HP-97/);
});

test("memory import rejects missing or ambiguous provenance and impossible dates", () => {
  for (const value of [
    report.replace("Source: Bluetooth calculator read", "Source: unknown"),
    report.replace("Source: Bluetooth calculator read\n", ""),
    report.replace("Captured:", "Source: DEMO EXAMPLE\nCaptured:"),
    report.replace("2026-09-17T17:51:50Z", "2026-02-30T17:51:50Z"),
    report.replace("2026-09-17T17:51:50Z", "yesterday"),
    report.replace("448 bytes", "447 bytes"),
    report.replace("Internal RAM (", "Internal RAM (duplicate)\nInternal RAM ("),
  ]) assert.throws(() => loadMemoryReport(value));
});

test("memory import recomputes register values from RAM rather than trusting summary text", () => {
  const reading = loadMemoryReport(report.replace("0: 1.072017200", "0: 9.999999999"));
  assert.equal(reading.registers[0].value, "1.072017200 × 10^3");
});

test("first card from captured RAM exactly matches the independently captured physical body", () => {
  const reading = loadMemoryReport(report);
  const cards = prepareMemoryCards(reading, template, "Recovered");
  assert.deepEqual(cards[0].record.slice(21), physical.slice(21));
  assert.deepEqual(validateProgramCard(cards[0].record).header.slice(0, 5), validateProgramCard(physical).header.slice(0, 5));
  assert.equal(cards[0].name, "Recovered 1 of 2");
  assert.equal(cards[1].name, "Recovered 2 of 2");
  assert.deepEqual(cards.map(card => [card.firstStep, card.lastStep]), [[1, 112], [113, 224]]);
});

test("extended Lucas–Lehmer pair retains exact HPP bodies and program order across the bank boundary", async () => {
  const originals = await Promise.all([1, 2].map(async part => decodeHPP(new Uint8Array(await readFile(
    new URL(`../../Programs/Lucas-Lehmer-Extended-HP97-card-${part}.hpp`, import.meta.url)))).record));
  const ram = new Uint8Array(448);
  originals.forEach((card, part) => copyCardToRAM(card, ram, part ? 0x1f : 0x2f));
  const reading = decodeRAM(ram);
  assert.equal(reading.program[0].opcode, 0xfa); // LBL A, independently known first instruction.
  const cards = prepareMemoryCards(reading, { bytes: originals[0], simulated: false }, "LL extended");
  cards.forEach((card, part) => {
    assert.deepEqual(decodeHPP(card.hpp).record, card.record);
    assert.deepEqual(card.record.slice(21), originals[part].slice(21));
  });
});

test("conversion preserves all 224 positions including zeros and never includes primary registers", () => {
  const ram = Uint8Array.from({ length: 448 }, (_, i) => (i * 79) % 256);
  ram[0x10 * 7 + 6] = 0; // Last instruction must remain, even when R/S.
  const before = ram.slice();
  const templateBefore = physical.slice();
  const cards = prepareMemoryCards(decodeRAM(ram), template, "All positions");
  const reconstructed = new Uint8Array(448);
  cards.forEach((card, part) => copyCardToRAM(card.record, reconstructed, part ? 0x1f : 0x2f));
  assert.deepEqual(reconstructed.slice(112, 336), before.slice(112, 336));
  assert.deepEqual(ram, before);
  assert.deepEqual(physical, templateBefore);
  ram.fill(0xff, 0, 112);
  ram.fill(0xff, 336);
  const changed = prepareMemoryCards(decodeRAM(ram), template, "All positions");
  cards.forEach((card, part) => assert.deepEqual(changed[part].hpp, card.hpp));
});

test("conversion accepts observed marker 61, and rejects vacant or damaged templates and invalid titles", () => {
  const reading = loadMemoryReport(report);
  const marker61 = physical.slice();
  marker61[0] = 0x61;
  assert.equal(prepareMemoryCards(reading, { bytes: marker61, simulated: false }, "Marker").length, 2);
  const damaged = physical.slice();
  damaged[55] ^= 1;
  for (const bytes of [new Uint8Array(150).fill(0xff), damaged]) {
    assert.throws(() => prepareMemoryCards(reading, { bytes, simulated: false }, "Bad"));
  }
  for (const name of ["", "              ", "12345678901234", "Résumé", "test\ncard"]) {
    assert.throws(() => prepareMemoryCards(reading, template, name), /1–13/);
  }
});

test("Demo provenance follows either source and preparation takes independent byte snapshots", () => {
  const reading = loadMemoryReport(report);
  const demoTemplate = { bytes: demoStoredSlot(0, 0), simulated: true };
  for (const [memory, card] of [[demoRAM(), template], [reading, demoTemplate]]) {
    assert.ok(prepareMemoryCards(memory, card, "Example").every(result => result.simulated));
  }
  assert.throws(() => prepareMemoryCards({ ...reading, simulated: undefined }, template, "Invalid"));
  const cards = prepareMemoryCards(reading, template, "Snapshot");
  const saved = cards[0].hpp.slice();
  reading.bytes.fill(0);
  assert.deepEqual(cards[0].hpp, saved);
});
