import { decodeRAM } from "./calculator.js";
import { encodeHPP, validateProgramCard } from "./stored-programs.js?v=0.5.0";

export function loadMemoryReport(text) {
  const invalid = () => new Error("This is not a complete HP-97 memory capture. Open a saved memory report with a capture date and all 64 RAM rows (448 bytes), not a program listing or a stored card.");
  if (typeof text !== "string" || text.length > 32768) throw invalid();
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const sources = lines.filter(line => line.startsWith("Source: "));
  const dates = lines.filter(line => line.startsWith("Captured: "));
  const sections = lines.filter(line => line.startsWith("Internal RAM ("));
  if (lines[0] !== "HP-97 active RAM capture" || sources.length !== 1 || dates.length !== 1 || sections.length !== 1 ||
      !["Source: DEMO EXAMPLE", "Source: Bluetooth calculator read"].includes(sources[0]) ||
      !lines.includes("448 bytes · 64 internal registers")) throw invalid();
  const stamp = dates[0].slice(10);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(stamp)) throw invalid();
  const capturedAt = new Date(stamp);
  const canonical = stamp.replace(/(?:\.(\d{1,3}))?Z$/, (_, digits = "") => `.${digits.padEnd(3, "0")}Z`);
  if (Number.isNaN(capturedAt.getTime()) || capturedAt.toISOString() !== canonical) throw invalid();
  const rows = lines.slice(lines.indexOf(sections[0]) + 1).filter(line => line.trim());
  if (rows.length !== 64) throw invalid();
  const bytes = new Uint8Array(448);
  rows.forEach((row, address) => {
    const fields = row.trim().split(/\s+/);
    if (fields.length !== 8 || fields.some(field => !/^[0-9A-Fa-f]{2}$/.test(field)) ||
        Number.parseInt(fields[0], 16) !== address) throw invalid();
    bytes.set(fields.slice(1).map(value => Number.parseInt(value, 16)), address * 7);
  });
  // Recompute all displayed registers and instructions from the raw bytes.
  // Text reports have no checksum; structural validation is not an integrity proof.
  return { ...decodeRAM(bytes), capturedAt, simulated: sources[0] === "Source: DEMO EXAMPLE" };
}

function cardRegisters(record) {
  validateProgramCard(record);
  const nibbles = Array.from(record.slice(21, 140)).flatMap(byte => [byte >> 4, byte & 15]);
  const bytes = [];
  for (let offset = 7; offset < 231; offset += 14) {
    const digits = [...nibbles.slice(offset + 7, offset + 14), ...nibbles.slice(offset, offset + 7)];
    for (let index = 0; index < 14; index += 2) bytes.push(digits[index] << 4 | digits[index + 1]);
  }
  return Uint8Array.from(bytes);
}

function encodeCard(registers, header, name) {
  const nibbles = [...header];
  for (let offset = 0; offset < 112; offset += 7) {
    const digits = Array.from(registers.slice(offset, offset + 7)).flatMap(byte => [byte >> 4, byte & 15]);
    nibbles.push(...digits.slice(7), ...digits.slice(0, 7));
  }
  let checksum = 0;
  for (let offset = 0; offset < 231; offset += 7) {
    checksum += nibbles.slice(offset, offset + 7).reduce((sum, digit, index) => sum + digit * (16 ** index), 0);
  }
  checksum &= 0x0fffffff;
  nibbles.push(...Array.from({ length: 7 }, (_, index) => (checksum >>> (index * 4)) & 15));
  const record = new Uint8Array(150).fill(0xff);
  record[0] = 0x43;
  record.set(new TextEncoder().encode(name), 1);
  for (let index = 0; index < 238; index += 2) record[21 + index / 2] = nibbles[index] << 4 | nibbles[index + 1];
  validateProgramCard(record);
  return record;
}

export function prepareMemoryCards(reading, template, name) {
  if (!(reading?.bytes instanceof Uint8Array) || reading.bytes.length !== 448 ||
      typeof reading.simulated !== "boolean" || typeof template?.simulated !== "boolean") {
    throw new Error("Read or open a complete memory capture and a valid card template first.");
  }
  const title = typeof name === "string" ? name.trim() : "";
  if (!/^[\x20-\x7e]{1,13}$/.test(title)) throw new Error("Use 1–13 plain English letters, numbers or punctuation for the program name.");
  const { header } = validateProgramCard(template.bytes);
  const simulated = reading.simulated || template.simulated;
  return [0, 1].map(part => {
    const highest = part === 0 ? 0x2f : 0x1f;
    const registers = new Uint8Array(112);
    for (let index = 0; index < 16; index += 1) {
      registers.set(reading.bytes.slice((highest - index) * 7, (highest - index + 1) * 7), index * 7);
    }
    const cardHeader = [...header];
    cardHeader[5] = 0; // Explicitly two cards, including every trailing R/S position.
    cardHeader[6] = 3 + part;
    const cardName = `${title} ${part + 1} of 2`;
    const record = encodeCard(registers, cardHeader, cardName);
    const decoded = cardRegisters(record);
    if (decoded.some((byte, index) => byte !== registers[index])) throw new Error("Program card conversion failed its byte comparison.");
    // encodeHPP also reopens the file and verifies its full title and card body.
    return { name: cardName, record, hpp: encodeHPP(record), simulated, firstStep: part * 112 + 1, lastStep: (part + 1) * 112 };
  });
}
