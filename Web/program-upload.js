import { decodeRAM, memoryReport } from "./calculator.js";
import { cardRegisters, loadMemoryReport } from "./memory-cards.js?v=0.6.0";
import { encodeStoredCapture, loadStoredCapture, makeStoredCapture, sha256, validateProgramCard } from "./stored-programs.js?v=0.5.0";

const FORMAT = "Teenio two-card backup v1";
const same = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const validRAM = bytes => bytes instanceof Uint8Array && bytes.length === 448;

export function validatePairLocation(block, slot) {
  if (!Number.isInteger(block) || block < 0 || block > 14 || !Number.isInteger(slot) || slot < 0 || slot > 52) {
    throw new Error("Choose a block 0–E and a first slot 00–52. The second card uses the following slot in the same block.");
  }
}

// Return the program area in ascending RAM-address order (10–2F).
export function programBytesFromCards(cards) {
  if (!Array.isArray(cards) || cards.length !== 2) throw new Error("Two ordered HP-97 program cards are required.");
  const headers = cards.map(record => validateProgramCard(record).header);
  if (headers.some((header, index) => header[5] !== 0 || header[6] !== 3 + index) ||
      !same(headers[0].slice(0, 5), headers[1].slice(0, 5))) {
    throw new Error("The cards must be a matching first and second program card, in that order.");
  }
  const program = new Uint8Array(224);
  cards.forEach((record, part) => {
    const registers = cardRegisters(record);
    const highest = part ? 15 : 31;
    for (let index = 0; index < 16; index += 1) {
      program.set(registers.slice(index * 7, index * 7 + 7), (highest - index) * 7);
    }
  });
  return program;
}

export function encodeProgramBackup(backup) {
  return JSON.stringify({ format: FORMAT, firmware: 21, block: backup.block, slot: backup.slot,
    simulated: backup.simulated, memory: { report: memoryReport(backup.memory), sha256: backup.memoryHash },
    slots: backup.slots.map(capture => JSON.parse(encodeStoredCapture(capture))),
  }, null, 2) + "\n";
}

export async function loadProgramBackup(text) {
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("This is not a Teenio two-card backup."); }
  if (!json || json.format !== FORMAT || json.firmware !== 21 || typeof json.simulated !== "boolean" ||
      !Array.isArray(json.slots) || json.slots.length !== 2 || typeof json.memory?.report !== "string") {
    throw new Error("This is not a complete Teenio two-card backup.");
  }
  validatePairLocation(json.block, json.slot);
  const memory = loadMemoryReport(json.memory.report);
  const memoryHash = await sha256(memory.bytes);
  const slots = await Promise.all(json.slots.map(slot => loadStoredCapture(JSON.stringify(slot))));
  if (memoryHash !== json.memory.sha256 || memory.simulated !== json.simulated ||
      slots.some((capture, index) => capture.block !== json.block || capture.slot !== json.slot + index || capture.simulated !== json.simulated)) {
    throw new Error("The two-card backup failed its integrity or destination checks.");
  }
  return { block: json.block, slot: json.slot, simulated: json.simulated, memory, memoryHash, slots };
}

export async function uploadProgramPair({ cards, memory, block, slot, simulated, readMemory, readSlot, writeSlot, saveBackup,
  ensureConnected = () => {}, onBackup = () => {}, onStage = () => {}, onWriteStart = () => {} }) {
  validatePairLocation(block, slot);
  if (typeof simulated !== "boolean" || !validRAM(memory?.bytes) || typeof memory.simulated !== "boolean" ||
      !Array.isArray(cards) || cards.length !== 2 || cards.some(card => typeof card.simulated !== "boolean")) {
    throw new Error("Prepare a complete program from a memory capture first.");
  }
  if (!simulated && (memory.simulated || cards.some(card => card.simulated))) throw new Error("Demo programs can only be uploaded in Demo mode.");
  // Freeze both source cards and their expected RAM before the first await.
  const frozen = cards.map(card => Uint8Array.from(card.record));
  const expectedProgram = memory.bytes.slice(112, 336);
  if (!same(programBytesFromCards(frozen), expectedProgram)) throw new Error("The prepared cards do not match the source memory.");
  ensureConnected();
  onStage("Reading current calculator memory for the backup…");
  const before = await readMemory();
  ensureConnected();
  if (!validRAM(before?.bytes) || before.simulated !== simulated || !(before.capturedAt instanceof Date) || Number.isNaN(before.capturedAt.getTime())) {
    throw new Error("The current-memory backup is incomplete or has the wrong source.");
  }
  const savedMemory = { ...decodeRAM(before.bytes.slice()), capturedAt: new Date(before.capturedAt), simulated };
  const slots = [];
  for (let part = 0; part < 2; part += 1) {
    ensureConnected();
    onStage(`Backing up destination ${part + 1} of 2 · slot ${String(slot + part).padStart(2, "0")}…`);
    slots.push(await makeStoredCapture(block, slot + part, await readSlot(block, slot + part), simulated));
    ensureConnected();
  }
  const backup = { block, slot, simulated, memory: savedMemory, memoryHash: await sha256(savedMemory.bytes), slots };
  const text = encodeProgramBackup(backup);
  // Give the UI a separate copy so retained recovery data cannot change this job.
  onBackup(await loadProgramBackup(text));
  ensureConnected();
  onStage("Saving and checking both slot backups and current memory…");
  const reopened = await loadProgramBackup(await saveBackup(text));
  if (encodeProgramBackup(reopened) !== text) throw new Error("The saved backup differs from the captured destinations or memory. No write was started.");
  ensureConnected();
  for (let part = 0; part < 2; part += 1) {
    ensureConnected();
    onStage(`Writing card ${part + 1} of 2 · slot ${String(slot + part).padStart(2, "0")}…`);
    onWriteStart(part);
    await writeSlot(block, slot + part, frozen[part].slice());
    ensureConnected();
    onStage(`Checking card ${part + 1} of 2 by reading it back…`);
    const actual = await readSlot(block, slot + part);
    ensureConnected();
    if (!same(actual, frozen[part])) throw new Error(`Card ${part + 1} read-back differs from the source. Upload stopped; retain the backup.`);
  }
  return { backup, expectedProgram, before: savedMemory.bytes.slice(), cards: frozen, block, slot, simulated };
}

export function compareLoadedProgram(before, expected, after) {
  if (!validRAM(before) || !validRAM(after) || !(expected instanceof Uint8Array) || expected.length !== 224) {
    throw new Error("Complete memory reads and a 224-position source are required for verification.");
  }
  const names = [...Array.from({ length: 10 }, (_, index) => String(index)), "A", "B", "C", "D", "E", "I"];
  const changedRegisters = names.filter((_, index) => !same(before.slice(index * 7, index * 7 + 7), after.slice(index * 7, index * 7 + 7)));
  const programMatches = same(expected, after.slice(112, 336));
  const alreadyPresent = same(expected, before.slice(112, 336));
  const verified = programMatches && changedRegisters.length === 0 && !alreadyPresent;
  const message = !programMatches
    ? `The active program does not match all 224 source positions.${changedRegisters.length ? ` Registers also changed: ${changedRegisters.join(", ")}.` : " All sixteen registers are unchanged."} Load both cards before checking again.`
    : changedRegisters.length ? `All 224 program positions match, but these registers changed: ${changedRegisters.join(", ")}.`
    : alreadyPresent ? "All 224 positions match and all sixteen registers are unchanged. The same program was already active before upload, so this cannot confirm that the cards were loaded."
    : "Loaded program verified: all 224 positions match the source and all sixteen registers are unchanged.";
  return { verified, programMatches, alreadyPresent, changedRegisters, message };
}
