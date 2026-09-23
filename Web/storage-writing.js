import {
  StorageError, StoredSlotWriteTransfer, encodeStoredCapture, loadStoredCapture,
  makeStoredCapture, sha256, validateProgramCard,
} from "./stored-programs.js?v=0.5.0";

function identical(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

// IO is supplied by the browser or Demo. No write request can precede a fresh
// destination read and a successfully reopened, independently checked backup.
export async function writeBackedUpSlot({ source, block, slot, simulated, read, write, saveBackup,
  ensureConnected = () => {}, onBackup = () => {}, onStage = () => {} }) {
  const bytes = Uint8Array.from(source.bytes);
  const sourceHash = source.sha256;
  if (source.simulated && !simulated) throw new StorageError("Demo cards cannot be written to the real calculator.");
  validateProgramCard(bytes);
  new StoredSlotWriteTransfer(block, slot, bytes); // Validate the chosen destination before any IO.
  if (await sha256(bytes) !== sourceHash) throw new StorageError("The source card failed its integrity check.");
  ensureConnected();
  onStage("Reading the destination before writing…");
  const backup = await makeStoredCapture(block, slot, await read(block, slot), simulated);
  ensureConnected();
  onBackup(backup);
  onStage("Saving and checking the destination backup…");
  const reopened = await loadStoredCapture(await saveBackup(encodeStoredCapture(backup)));
  if (reopened.block !== block || reopened.slot !== slot || reopened.simulated !== simulated ||
      !identical(reopened.bytes, backup.bytes)) {
    throw new StorageError("The saved destination backup does not match. No write was started.");
  }
  ensureConnected();
  onStage("Writing the selected card…");
  await write(block, slot, bytes);
  ensureConnected();
  onStage("Reading the written slot to verify all 150 bytes…");
  const actual = await read(block, slot);
  ensureConnected();
  if (!identical(actual, bytes)) {
    throw new StorageError("The written slot does not match the source. Keep the destination backup; do not retry automatically.");
  }
  return { backup, capture: await makeStoredCapture(block, slot, actual, simulated) };
}

export async function saveBackupFile(handle, text) {
  const writer = await handle.createWritable();
  try {
    await writer.write(text);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
  // Read from disk after close, rather than trusting the bytes passed to write().
  return (await handle.getFile()).text();
}
