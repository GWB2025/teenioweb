import {
  DEMO_INFORMATION_REPLY,
  INFORMATION_QUERY,
  InformationDecoder,
  decodeInformation,
  hex,
  settingsReport,
} from "./protocol.js";
import {
  ClockReadTransfer,
  ClockWriteTransfer,
  RAMReadTransfer,
  decodeRAM,
  demoRAM,
  memoryReport,
  programReport,
} from "./calculator.js";
import {
  DirectoryTransfer,
  StoredSlotReadTransfer,
  StoredSlotWriteTransfer,
  decodeHPP,
  demoDirectory,
  demoStoredSlot,
  encodeHPP,
  encodeStoredCapture,
  loadStoredCapture,
  makeStoredCapture,
  isVacantSlot,
  validateProgramCard,
  writeDemoSlot,
} from "./stored-programs.js?v=0.5.0";
import { saveBackupFile, writeBackedUpSlot } from "./storage-writing.js?v=0.5.0";
import { loadMemoryReport, prepareMemoryCards } from "./memory-cards.js?v=0.6.0";
import { compareLoadedProgram, encodeProgramBackup, loadProgramBackup, programBytesFromCards, uploadProgramPair, validatePairLocation } from "./program-upload.js?v=0.6.0";
import { WebSerialTransport } from "./serial.js?v=0.5.1";
import { HP97SController, DemoHP97SDevice, encodeHP97SEntry } from "./hp97s.js?v=0.7.1";

const elements = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), element => [element.id, element]));
function hp97sRecoverySaved() {
  try { return sessionStorage.getItem("teenio.hp97sRecovery") === "true"; } catch { return false; }
}
const state = {
  connected: false,
  connecting: false,
  busy: false,
  reading: null,
  settingsIssue: null,
  clockReading: null,
  clockVerified: false,
  memoryReading: null,
  memoryView: "registers",
  preparedProgram: null,
  directoryEntries: null,
  directoryBlock: null,
  storedCapture: null,
  writeJob: null,
  lastBackup: null,
  lastPairBackup: null,
  programLoad: null,
  verifying: false,
  demoMemory: demoRAM().bytes,
  session: 0,
  closing: false,
  bytesReceived: 0,
  pending: null,
  transport: null,
  receiveChain: Promise.resolve(),
  demoClock: { value: new Date(), reference: performance.now() },
  logs: [],
  installPrompt: null,
  hp97s: null,
  hp97sDemo: null,
  hp97sReview: null,
  hp97sLogs: [],
  hp97sRecovery: hp97sRecoverySaved(),
};

function baseLocked() { return Boolean(state.busy || state.writeJob || state.closing || state.verifying || state.hp97sReview); }
function locked() { return baseLocked() || Boolean(state.hp97s?.blocksNormalCommands) || state.hp97sRecovery; }

function timestamp() {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
}

function log(message) {
  state.logs.push(`${timestamp()}  ${message}`);
  state.logs = state.logs.slice(-400);
  elements.activity.textContent = state.logs.join("\n");
  elements.activity.scrollTop = elements.activity.scrollHeight;
  elements.saveLog.disabled = state.logs.length === 0;
}

function setStatus(message, tone = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function verifiedFirmware() {
  return Boolean(state.reading && (state.reading.simulated || (state.reading.model === "HP-97" && state.reading.firmware === "21")));
}

function renderSettings() {
  if (!state.reading) {
    elements.settings.innerHTML = '<p class="empty">Connect and choose <strong>Read settings</strong>.</p>';
    elements.lastRead.textContent = "No settings read in this session";
    return;
  }
  elements.settings.replaceChildren(...state.reading.settings.map(([name, value]) => {
    const row = document.createElement("div");
    row.className = "setting-row";
    row.title = `${name}: ${value}. Reported by the last settings read; choose Read settings to refresh. This row is read-only.`;
    const label = document.createElement("span");
    label.textContent = name;
    const result = document.createElement("strong");
    result.textContent = value;
    row.append(label, result);
    return row;
  }));
  elements.lastRead.textContent = `Last read: ${state.reading.capturedAt.toLocaleString()}`;
}

function renderClock() {
  elements.readClock.disabled = !state.connected || locked() || !verifiedFirmware();
  elements.setClock.disabled = !state.connected || locked() || (!elements.demo.checked && !state.clockVerified);
  elements.useComputerTime.disabled = locked();
  elements.clockValue.textContent = state.clockReading ? state.clockReading.toLocaleString() : "Clock not read";
}

function memoryRow(className, values) {
  const row = document.createElement("div");
  row.className = className;
  values.forEach(({ text, className: valueClass, title }) => {
    const value = document.createElement("span");
    value.textContent = text;
    if (valueClass) value.className = valueClass;
    if (title) value.title = title;
    row.append(value);
  });
  return row;
}

function renderMemory() {
  elements.readMemory.disabled = !state.connected || locked() || !verifiedFirmware();
  elements.openMemory.disabled = locked();
  elements.saveMemory.disabled = !state.memoryReading;
  elements.saveListing.disabled = !state.memoryReading;
  document.querySelectorAll("[data-memory-view]").forEach(button => button.classList.toggle("active", button.dataset.memoryView === state.memoryView));

  if (!state.memoryReading) {
    elements.memoryContent.innerHTML = '<p class="empty">Read active memory to display all sixteen registers and 224 program positions.</p>';
    return;
  }
  if (state.memoryView === "registers") {
    elements.memoryContent.replaceChildren(...state.memoryReading.registers.map(register => memoryRow("register-row", [
      { text: register.name, title: `Primary storage register ${register.name}.` },
      { text: register.value, title: `Value decoded from register ${register.name} in the current memory capture.` },
      { text: register.hex, className: "raw", title: `The seven original bytes for register ${register.name}, shown in hexadecimal.` },
    ])));
  } else if (state.memoryView === "listing") {
    elements.memoryContent.replaceChildren(...state.memoryReading.program.map(step => memoryRow("listing-row", [
      { text: String(step.number).padStart(3, "0"), title: `Program position ${step.number} of 224. Trailing R/S positions are retained.` },
      { text: step.opcode.toString(16).padStart(2, "0").toUpperCase(), title: "The decoded instruction code in hexadecimal." },
      { text: step.instruction, title: `Instruction at position ${step.number}: ${step.instruction}.` },
      { text: `[${step.keyCodes}]`, title: "Key codes corresponding to this instruction in the calculator’s program listing." },
    ])));
  } else {
    const raw = document.createElement("pre");
    raw.className = "raw-memory";
    raw.title = "All 64 internal RAM rows: each hexadecimal address is followed by seven captured bytes.";
    raw.textContent = state.memoryReading.rows.join("\n");
    elements.memoryContent.replaceChildren(raw);
  }
}

function renderProgramExport() {
  if (state.preparedProgram && (state.preparedProgram.memory !== state.memoryReading ||
      state.preparedProgram.template !== state.storedCapture || state.preparedProgram.title !== elements.programName.value)) {
    state.preparedProgram = null;
    elements.programExportMessage.textContent = "Source or name changed. Prepare the cards again before exporting.";
  }
  let templateName = null;
  try { templateName = validateProgramCard(state.storedCapture?.bytes ?? []).name; } catch { /* No valid template yet. */ }
  elements.cardTemplate.textContent = templateName !== null
    ? `Card settings from: ${state.storedCapture.simulated ? "DEMO · " : ""}${templateName || "Unnamed card"}.`
    : "Read or open a valid card in Stored programs to supply its display settings and flags.";
  elements.exportMemorySource.textContent = state.memoryReading
    ? `${state.memoryReading.simulated ? "DEMO · " : ""}${state.memoryReading.fileName ? `File: ${state.memoryReading.fileName}` : "Calculator memory capture"} · ${state.memoryReading.capturedAt.toLocaleString()} · 224 positions.`
    : "Read memory above or open a saved memory capture first.";
  elements.prepareProgram.disabled = locked() || !state.memoryReading || templateName === null;
  elements.programName.disabled = locked();
  elements.programExports.hidden = !state.preparedProgram;
  for (let part = 1; part <= 2; part += 1) {
    elements[`exportPart${part}`].disabled = locked() || !state.preparedProgram;
    const card = state.preparedProgram?.cards[part - 1];
    elements[`part${part}Name`].textContent = card ? `${card.simulated ? "DEMO · " : ""}${card.name}` : "";
  }
}

function updateSlotSelection() {
  const block = Number(elements.storageBlock.value);
  const slot = Number(elements.storageSlot.value);
  elements.directoryGrid.querySelectorAll("[data-slot]").forEach(button => {
    const selected = Number(button.dataset.slot) === slot;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  elements.slotSelection.textContent = `Selected: block ${block.toString(16).toUpperCase()}, slot ${String(slot).padStart(2, "0")}. Choose Read selected slot to read this card.`;
  renderPairUpload();
}

function renderPairUpload() {
  const program = state.preparedProgram;
  const slot = Number(elements.storageSlot.value);
  const block = Number(elements.storageBlock.value).toString(16).toUpperCase();
  const demoSource = program?.memory.simulated || program?.cards.some(card => card.simulated);
  const fileSaving = elements.demo.checked || typeof window.showSaveFilePicker === "function";
  elements.uploadPair.disabled = !program || !state.connected || locked() || !verifiedFirmware() || slot > 52 ||
    !fileSaving || (!elements.demo.checked && demoSource);
  elements.pairSource.textContent = program ? `${demoSource ? "DEMO · " : ""}${program.cards.map(card => card.name).join(" + ")} · 224 positions.`
    : "Prepare two cards in Memory & registers, then return here to select their destination.";
  elements.pairDestination.textContent = slot > 52 ? "Slot 53 has no following slot. Choose a first slot from 00 to 52."
    : `Destination: block ${block}, slots ${String(slot).padStart(2, "0")} and ${String(slot + 1).padStart(2, "0")}. Both existing slots will be backed up before either is replaced.`;
  elements.pairAvailability.textContent = !fileSaving ? "Live uploading requires desktop Chrome’s file-saving support."
    : !elements.demo.checked && demoSource ? "Demo programs can only be uploaded in Demo mode." : "";
  elements.pairProgress.hidden = !(state.writeJob?.kind === "pair" && state.writeJob.started);
  const load = state.programLoad;
  elements.loadInstructions.hidden = !load;
  elements.verifyProgram.disabled = !load || !state.connected || locked() || !verifiedFirmware() || elements.demo.checked !== load.simulated;
  elements.simulateLoad.hidden = !load?.simulated;
  elements.simulateLoad.disabled = elements.verifyProgram.disabled;
  elements.saveVerification.disabled = !load?.report || locked();
  if (load) elements.loadLocation.textContent = `${load.simulated ? "Demo upload" : "Uploaded cards"}: block ${load.block.toString(16).toUpperCase()}, slots ${String(load.slot).padStart(2, "0")} and ${String(load.slot + 1).padStart(2, "0")}.`;
  elements.openPairBackup.disabled = locked();
  for (const id of ["savePairBackup", "extractPairMemory", "extractPairSlot1", "extractPairSlot2"]) elements[id].disabled = !state.lastPairBackup || locked();
  const backup = state.lastPairBackup;
  elements.pairBackupSummary.textContent = backup
    ? `${backup.simulated ? "DEMO · " : ""}Backup of block ${backup.block.toString(16).toUpperCase()}, slots ${String(backup.slot).padStart(2, "0")} and ${String(backup.slot + 1).padStart(2, "0")} plus 448 memory bytes · ${backup.memory.capturedAt.toLocaleString()}.`
    : "No two-card backup in this session. Open a saved backup to extract its memory report and individual slot captures.";
}

function renderStorage() {
  const block = Number(elements.storageBlock.value || 0);
  const usable = state.connected && !locked() && verifiedFirmware();
  elements.scanDirectory.disabled = !usable;
  elements.readSlot.disabled = !usable;
  elements.storageBlock.disabled = locked();
  elements.storageSlot.disabled = locked();
  elements.openCapture.disabled = locked();
  elements.openHPP.disabled = locked();
  elements.saveCapture.disabled = !state.storedCapture || locked();
  let cardIsValid = false;
  if (state.storedCapture) {
    try { validateProgramCard(state.storedCapture.bytes); cardIsValid = true; } catch { cardIsValid = false; }
  }
  elements.exportHPP.disabled = !cardIsValid || locked();
  const backupAvailable = elements.demo.checked || typeof window.showSaveFilePicker === "function";
  elements.writeSlot.disabled = !usable || !cardIsValid || !backupAvailable ||
    (!elements.demo.checked && state.storedCapture?.simulated);
  elements.writeAvailability.textContent = !backupAvailable
    ? "Writing needs Chrome’s file-saving permission so the destination backup can be saved and checked. Open Teenio in desktop Chrome."
    : !elements.demo.checked && state.storedCapture?.simulated
      ? "Demo captures can only be written in Demo mode."
      : "Write the current card to the selected block and slot. Its existing contents will be backed up first.";
  elements.saveBackup.disabled = !state.lastBackup || locked();
  elements.backupMessage.textContent = state.lastBackup
    ? `${state.lastBackup.simulated ? "Demo backup" : "Destination backup"}: block ${state.lastBackup.block.toString(16).toUpperCase()}, slot ${String(state.lastBackup.slot).padStart(2, "0")} · ${state.lastBackup.capturedAt.toLocaleString()}`
    : "No destination backup in this session.";

  if (state.directoryEntries && state.directoryBlock === block) {
    elements.directoryGrid.replaceChildren(...state.directoryEntries.map((entry, index) => {
      const button = document.createElement("button");
      button.className = `directory-entry${entry ? "" : " vacant"}`;
      button.type = "button";
      button.dataset.slot = String(index);
      button.disabled = locked();
      button.title = `Select block ${block.toString(16).toUpperCase()}, slot ${String(index).padStart(2, "0")}: ${entry ? (entry.name || "Occupied, unnamed card") : "Vacant"}. Then choose Read selected slot. Selecting an entry does not read or write data.`;
      const number = document.createElement("span");
      number.textContent = String(index).padStart(2, "0");
      const name = document.createElement("span");
      name.textContent = entry ? (entry.name || "Occupied (unnamed)") : "Vacant";
      button.append(number, name);
      return button;
    }));
  } else {
    elements.directoryGrid.innerHTML = '<p class="empty">Choose a block and scan its 54-slot directory.</p>';
  }
  updateSlotSelection();

  if (!state.storedCapture) {
    elements.storedCard.innerHTML = '<p class="empty">Read a slot or open a saved Teenio capture or HP-97 .hpp card.</p>';
    return;
  }
  let format;
  try {
    const card = validateProgramCard(state.storedCapture.bytes);
    format = `HP-97 program card · ${card.header[6] === 3 ? "first/single card" : "second card"}`;
  } catch (error) { format = isVacantSlot(state.storedCapture.bytes) ? "Vacant slot" : error.message; }
  const fields = [
    ["Name", state.storedCapture.name || "Unnamed or vacant"],
    ["Source", state.storedCapture.importedHPP ? "Imported HP-97 .hpp" : `${state.storedCapture.simulated ? "Demo" : "Capture"} · block ${state.storedCapture.block.toString(16).toUpperCase()} slot ${String(state.storedCapture.slot).padStart(2, "0")}`],
    ["Format", format],
    ["Integrity", `${cardIsValid ? "Card checksum verified · " : ""}SHA-256 ${state.storedCapture.sha256}`],
  ];
  const summary = document.createElement("div");
  summary.className = "card-summary";
  const fieldTips = {
    Name: "The name stored in the current card, which may differ from its filename.",
    Source: "Where this card was read or imported. Write destinations are chosen separately above.",
    Format: "Whether the current capture is a valid program card, a vacant slot or an unrecognised record.",
    Integrity: "The capture’s SHA-256 hash and, for recognised cards, the program-card checksum result.",
  };
  fields.forEach(([label, value]) => {
    const field = document.createElement("div");
    field.title = fieldTips[label];
    const caption = document.createElement("span");
    caption.textContent = label;
    const result = document.createElement("strong");
    result.textContent = value;
    field.append(caption, result);
    summary.append(field);
  });
  elements.storedCard.replaceChildren(summary);
}

function logHP97S(message) {
  const prefix = elements.demo.checked ? "DEMO HP-97S" : "HP-97S";
  state.hp97sLogs.push(`${timestamp()}  ${prefix} · ${message}`);
  state.hp97sLogs = state.hp97sLogs.slice(-400);
  elements.hp97sLog.textContent = state.hp97sLogs.join("\n");
  elements.hp97sLog.scrollTop = elements.hp97sLog.scrollHeight;
  elements.hp97sSaveLog.disabled = false;
  log(`${prefix} · ${message}`);
}

function hp97sEntry() {
  try { return { entry: encodeHP97SEntry(elements.hp97sDigits.value) }; }
  catch (error) { return { error: error.message }; }
}

function renderHP97S() {
  const controller = state.hp97s;
  const mode = controller?.mode ?? "off";
  const busy = baseLocked() || Boolean(controller?.busy);
  const readyForMode = state.connected && (verifiedFirmware() || mode === "on") && !state.hp97sRecovery;
  const enabled = readyForMode && mode === "on" && !busy;
  elements.hp97sToggle.textContent = mode === "entering" ? "Turning on…" : mode === "leaving" ? "Turning off…" : mode === "on" ? "Turn interface off" : "Turn interface on";
  elements.hp97sToggle.disabled = !readyForMode || busy || mode === "fault";
  elements.hp97sToggle.title = mode === "on" ? "Leave HP-97S mode and wait for confirmation before resuming normal calculator commands." : "Enter CalCom-compatible HP-97S test mode over this connection. Use RUN and leave 97S off in the calculator’s own menu; Teenio enables the PC test mode.";
  elements.hp97sReadStatus.disabled = !enabled;
  elements.hp97sDigits.disabled = busy || mode === "fault" || state.hp97sRecovery;
  const { entry, error } = hp97sEntry();
  elements.hp97sSend.disabled = !enabled || !entry;
  elements.hp97sPreview.textContent = entry ? `${entry.codes.length - 1}/9 keys · ${entry.labels.join(" → ")}` : error;
  elements.hp97sPreview.dataset.tone = entry ? "neutral" : "error";
  document.querySelectorAll("[data-hp97s-key]").forEach(button => { button.disabled = elements.hp97sDigits.disabled; });
  elements.hp97sMode.textContent = state.hp97sRecovery || mode === "fault" ? "Recovery required" : mode === "off" ? "Off" : mode === "on" ? "On" : "Changing mode…";
  const status = mode === "on" ? controller?.status : null;
  elements.hp97sReady.textContent = status ? (status.ready ? "Yes" : "No") : "Unknown";
  for (let bit = 0; bit < 4; bit++) elements[`hp97sFlag${bit}`].textContent = status ? (status.flags[bit] ? "Set" : "Clear") : "Unknown";
  elements.hp97sRequirement.textContent = state.hp97sRecovery || mode === "fault"
    ? "The previous exchange did not finish safely. Disconnect, switch the calculator off/on, restore its Bluetooth connection mode, then confirm recovery below before reconnecting. No transfer is retried."
    : !state.connected ? "Connect and read settings first. Demo mode is available without a calculator."
    : mode === "on" ? "HP-97S mode owns this connection. Turn it off to use normal settings, clock, memory and card operations."
    : !verifiedFirmware() ? "Read settings to verify HP-97 firmware 21 before turning on the interface."
    : "Use RUN and leave 97S off in the calculator’s own menu, then turn the interface on here. The calculator menu is for the separate external-equipment connection.";
  elements.hp97sRecoveryPanel.hidden = !state.hp97sRecovery && mode !== "fault";
  elements.hp97sRecovered.disabled = state.connected || busy;
  elements.hp97sRecovered.textContent = elements.demo.checked ? "Reset Demo interface" : "I have restarted the calculator";
  elements.hp97sDemoControls.hidden = !elements.demo.checked;
  document.querySelectorAll("[data-hp97s-flag]").forEach(button => { button.disabled = !enabled; });
  elements.hp97sSaveLog.disabled = !state.hp97sLogs.length;
  elements.hp97sConfirm.disabled = !state.hp97sReview || !state.connected || mode !== "on" || Boolean(controller?.busy);
  elements.hp97sNotice.hidden = !controller?.blocksNormalCommands && !state.hp97sRecovery;
}

function createHP97S() {
  const session = state.session;
  const simulated = elements.demo.checked;
  const peer = simulated ? new DemoHP97SDevice() : null;
  state.hp97sDemo = peer;
  const controller = new HP97SController({
    write: packet => {
      if (!state.connected || state.session !== session || elements.demo.checked !== simulated) throw new Error("The calculator connection changed.");
      if (peer) {
        const response = peer.write(packet);
        queueMicrotask(() => { if (state.session === session && state.hp97s === controller) controller.receive(response); });
        return;
      }
      return state.transport.write(packet);
    },
    onLog: logHP97S,
    onChange: current => {
      if (state.hp97s !== current) return;
      if (!simulated) {
        try {
          if (current.mode !== "off") sessionStorage.setItem("teenio.hp97sRecovery", "true");
          else if (!state.hp97sRecovery) sessionStorage.removeItem("teenio.hp97sRecovery");
        } catch { /* The unload warning and in-session recovery remain available. */ }
      }
      if (current.mode === "fault") {
        state.hp97sRecovery = true;
        state.hp97sReview = null;
        elements.hp97sSendDialog.close();
        elements.hp97sMessage.textContent = `${current.error.message} Stop and recover the calculator connection; completion is uncertain.`;
        setStatus("HP-97S exchange stopped · recovery required", "error");
      }
      render();
    },
  });
  state.hp97s = controller;
  return controller;
}

async function hp97sAction(action) {
  if (!state.connected || (!verifiedFirmware() && state.hp97s?.mode !== "on") || baseLocked() || state.hp97sRecovery || state.hp97s?.busy) return;
  const controller = state.hp97s ?? createHP97S();
  try {
    if (action === "toggle") {
      if (controller.mode === "on") await controller.leave(); else await controller.enter();
      elements.hp97sMessage.textContent = controller.mode === "on" ? "Interface on. Choose Read status to check readiness and flags." : "Interface off. Normal calculator functions are available.";
      setStatus(`HP-97S interface ${controller.mode === "on" ? "on" : "off"}`, "success");
    } else {
      const status = await controller.readStatus();
      elements.hp97sMessage.textContent = status.ready ? "The calculator reports that it is ready for a transfer." : "The calculator is not ready. Check RUN mode, program activity and Flag 3.";
      setStatus(status.ready ? "HP-97S ready" : "HP-97S not ready", status.ready ? "success" : "neutral");
    }
  } catch (error) { elements.hp97sMessage.textContent = error.message; setStatus(error.message, "error"); logHP97S(error.message); }
  render();
}

function reviewHP97SSend() {
  if (baseLocked() || state.hp97sRecovery || !state.connected || state.hp97s?.mode !== "on" || state.hp97s.busy) return;
  const { entry } = hp97sEntry();
  if (!entry) return;
  state.hp97sReview = { entry, session: state.session, controller: state.hp97s, simulated: elements.demo.checked };
  elements.hp97sSendReview.textContent = `${elements.demo.checked ? "Send to the Demo interface" : "Send these keys to the connected HP-97"}: ${entry.labels.join(" → ")}. ${entry.runsProgram ? "Run A requests execution of the program at label A. " : ""}${elements.demo.checked ? "Demo records the keys and simulates flags; it does not execute calculator programs." : "This changes calculator key-entry data and may affect X, the stack and flags. The current memory view and pending upload comparison will be cleared; save any wanted capture before continuing."}`;
  render();
  elements.hp97sSendDialog.showModal();
}

async function confirmHP97SSend() {
  const review = state.hp97sReview;
  state.hp97sReview = null;
  elements.hp97sSendDialog.close();
  if (!review || review.session !== state.session || review.controller !== state.hp97s || !state.connected ||
      review.simulated !== elements.demo.checked || baseLocked() || state.hp97sRecovery || state.hp97s.busy || state.hp97s.mode !== "on") { render(); return; }
  // Old captures and pending upload comparisons no longer describe current key-entry state.
  if (!review.simulated) {
    state.programLoad = null;
    state.memoryReading = null;
    state.preparedProgram = null;
    state.reading = null;
    state.clockVerified = false;
    elements.memoryMessage.textContent = "HP-97S input may change calculator state. Turn the interface off, then read settings and memory again.";
  }
  try {
    const entry = await review.controller.send(review.entry.text);
    elements.hp97sMessage.textContent = `${review.simulated ? "DEMO · " : ""}Keys accepted: ${entry.labels.slice(0, -1).join(" → ")}. Read status again for fresh flags. ${review.simulated ? "Demo does not execute programs or change the separate Demo memory capture." : "Check the calculator display; acknowledgement does not verify its value or program result."}`;
    setStatus("HP-97S key transfer accepted", "success");
  } catch (error) { elements.hp97sMessage.textContent = error.message; setStatus(error.message, "error"); logHP97S(error.message); }
  render();
}

async function userDisconnect() {
  if (baseLocked() || state.hp97s?.busy) return;
  if (state.hp97s?.mode === "on") {
    try { await state.hp97s.leave(); }
    catch { /* Disconnect below; recovery remains required after an uncertain exit. */ }
  }
  await disconnect();
}

function render() {
  elements.connectLabel.textContent = state.connecting ? "Connecting…" : state.connected ? "Disconnect" : "Connect to TEENIX97";
  elements.connect.title = state.closing ? "Closing the connection and releasing the serial port."
    : state.connecting ? "Waiting for device selection or the Bluetooth serial connection to open."
    : state.connected ? (elements.demo.checked ? "End the simulated connection. No Bluetooth device is in use." : "Close this calculator connection and release its serial port for another app.")
    : elements.demo.checked ? "Connect to an example calculator in this browser. No Bluetooth device is used."
    : "Choose the paired TEENIX97 in the browser’s device chooser and open its Bluetooth serial connection.";
  elements.connectSpinner.hidden = !state.connecting;
  elements.connect.setAttribute("aria-busy", String(state.connecting));
  elements.connect.disabled = baseLocked() || Boolean(state.hp97s?.busy) || (!state.connected && state.hp97sRecovery);
  elements.readSettings.disabled = !state.connected || locked();
  elements.saveSettings.disabled = !state.reading;
  elements.demo.disabled = locked();
  elements.bytes.textContent = String(state.bytesReceived);
  elements.model.textContent = state.reading?.model ?? "Not verified";
  elements.firmware.textContent = state.reading?.firmware ?? "Not read";
  elements.connectionRecovery.hidden = !state.settingsIssue;
  elements.connectionDiagnosis.textContent = state.settingsIssue ?? "";
  elements.sourceBadge.textContent = elements.demo.checked ? "DEMO" : "WEB SERIAL";
  elements.sourceBadge.title = elements.demo.checked ? "Simulated calculator data. Demo mode does not open Bluetooth."
    : "Live calculator mode using a Bluetooth serial connection. Imported files may also be viewed.";
  renderSettings();
  renderClock();
  renderMemory();
  renderStorage();
  renderProgramExport();
  renderPairUpload();
  renderHP97S();
}

function showPage(name) {
  document.querySelectorAll(".page").forEach(page => page.hidden = page.id !== `page-${name}`);
  document.querySelectorAll("[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === name));
}

function completeSettings(info, simulated) {
  state.reading = { ...info, capturedAt: new Date(), simulated };
  state.busy = false;
  setStatus(`${simulated ? "Demo" : "HP-97"} settings read successfully`, "success");
  log(`${simulated ? "Decoded Demo" : "Verified HP-97"} response. Firmware version: ${info.firmware}.`);
  render();
}

function failOperation(error, disconnectOnError = state.pending?.disconnectOnError) {
  const pending = state.pending;
  if (pending?.timer) clearTimeout(pending.timer);
  state.pending = null;
  state.busy = false;
  if (pending?.kind === "settings") {
    state.reading = null;
    state.clockVerified = false;
    const received = pending.decoder.bytes.length;
    state.settingsIssue = received
      ? `The calculator returned ${received} of the expected 8 settings bytes, but Teenio could not verify the reply. ${error.message}`
      : pending.writeComplete
        ? "The browser finished sending the settings query, but no calculator reply arrived. An open Bluetooth port does not confirm that the calculator is responding."
        : "The browser did not confirm completion of the settings query. The Bluetooth connection may have stalled while sending.";
    log(state.settingsIssue);
  }
  pending?.onError?.(error);
  setStatus(error.message, "error");
  log(`Operation failed: ${error.message}`);
  render();
  if (disconnectOnError && !elements.demo.checked) void disconnect(error.message);
}

function armOperationTimeout() {
  if (!state.pending) return;
  clearTimeout(state.pending.timer);
  const pending = state.pending;
  pending.timer = setTimeout(() => {
    if (state.pending === pending) failOperation(new Error(pending.timeoutMessage), pending.disconnectOnError);
  }, pending.timeoutMs);
}

async function sendPacket(packet, label, showBytes = true) {
  if (showBytes) log(`${label} TX: ${hex(packet)}`);
  await state.transport.write(packet);
}

async function handleReceived(bytes) {
  state.bytesReceived += bytes.length;
  log(`Received ${bytes.length} byte${bytes.length === 1 ? "" : "s"}: ${hex(bytes)}`);
  if (state.hp97s?.blocksNormalCommands) {
    state.hp97s.receive(bytes);
    elements.bytes.textContent = String(state.bytesReceived);
    return;
  }
  const pending = state.pending;
  if (!pending) {
    render();
    return;
  }
  try {
    if (pending.kind === "settings") {
      const info = pending.decoder.append(bytes);
      if (info) {
        clearTimeout(pending.timer);
        state.pending = null;
        completeSettings(info, false);
      } else {
        armOperationTimeout();
      }
      return;
    }

    const update = pending.decoder.append(bytes);
    for (const packet of update.packets) await sendPacket(packet, pending.label, pending.logPackets);
    if (state.pending !== pending) return; // A disconnect may have interrupted the write.
    if (update.complete) {
      clearTimeout(pending.timer);
      state.pending = null;
      state.busy = false;
      await pending.onComplete(update.result);
    } else {
      armOperationTimeout();
    }
  } catch (error) {
    failOperation(error, pending.disconnectOnError);
  }
  render();
}

function receive(bytes, session) {
  state.receiveChain = state.receiveChain.then(() => {
    if (state.session === session) return handleReceived(bytes);
  }).catch(error => failOperation(error, true));
}

function resetReadings() {
  state.reading = null;
  state.settingsIssue = null;
  state.clockReading = null;
  state.clockVerified = false;
  state.memoryReading = null;
  state.directoryEntries = null;
  state.directoryBlock = null;
  state.storedCapture = null;
  elements.clockMessage.textContent = "Read the board clock before setting it.";
  elements.memoryMessage.textContent = "Read settings first to verify HP-97 firmware 21.";
  elements.directoryMessage.textContent = "Read settings first to verify HP-97 firmware 21.";
  elements.storageMessage.textContent = "Open or read a program card, choose its destination, then review the write.";
}

async function connect() {
  if (locked() || state.connected) return;
  const session = ++state.session;
  if (elements.demo.checked) {
    state.connected = true;
    state.bytesReceived = 0;
    resetReadings();
    state.demoClock = { value: new Date(), reference: performance.now() };
    setStatus("Demo calculator connected", "success");
    log("DEMO MODE · no Bluetooth connection was opened.");
    render();
    return;
  }
  state.connecting = true;
  state.busy = true;
  setStatus("Choose the paired TEENIX97 in Chrome…");
  render();
  let deviceChosen = false;
  try {
    state.transport = new WebSerialTransport({
      onBytes: bytes => receive(bytes, session),
      onDisconnect: () => {
        if (state.session === session) {
          log("Bluetooth serial connection closed.");
          void disconnect("The serial connection closed");
        }
      },
      onLog: log,
      onConnecting: () => {
        deviceChosen = true;
        if (state.session === session) setStatus("Connecting to TEENIX97… Keep the calculator switched on and nearby.");
      },
    });
    await state.transport.connect();
    if (state.session !== session) return;
    state.connected = true;
    state.busy = false;
    state.bytesReceived = 0;
    resetReadings();
    setStatus("Bluetooth port open · read settings to verify the calculator");
  } catch (error) {
    if (state.session !== session) return;
    state.transport = null;
    state.connected = false;
    state.busy = false;
    const cancelled = !deviceChosen && (error.name === "NotFoundError" || error.name === "AbortError");
    setStatus(cancelled ? "Connection cancelled. Choose Connect to try again." : error.message, cancelled ? "neutral" : "error");
    log(cancelled ? "Connection cancelled." : `Connection failed: ${error.message}`);
  } finally {
    if (state.session === session) {
      state.connecting = false;
      render();
    }
  }
}

async function disconnect(reason = "Disconnected") {
  const pending = state.pending;
  const transport = state.transport;
  state.session += 1;
  state.transport = null;
  state.connected = false;
  state.connecting = false;
  state.closing = true;
  if (state.hp97s?.close()) state.hp97sRecovery = true;
  state.hp97s = null;
  state.hp97sDemo = null;
  state.hp97sReview = null;
  elements.hp97sSendDialog.close();
  if (state.pending?.timer) clearTimeout(state.pending.timer);
  state.pending = null;
  pending?.onError?.(new Error(reason));
  state.busy = true;
  setStatus(reason, reason === "Disconnected" ? "neutral" : "error");
  render();
  try {
    await transport?.disconnect();
  } catch (error) {
    log(`Disconnect warning: ${error.message}`);
  }
  state.closing = false;
  state.busy = false;
  state.clockVerified = false;
  log("Disconnected from calculator.");
  render();
}

async function readSettings() {
  if (locked() || !state.connected) return;
  // Do not leave write controls enabled by an older successful settings read.
  state.reading = null;
  state.clockVerified = false;
  state.settingsIssue = null;
  state.busy = true;
  setStatus("Reading calculator information…");
  render();
  if (elements.demo.checked) {
    completeSettings(decodeInformation(DEMO_INFORMATION_REPLY), true);
    return;
  }
  const decoder = new InformationDecoder();
  const pending = state.pending = {
    kind: "settings",
    decoder,
    timeoutMs: 5000,
    timeoutMessage: "The calculator information reply timed out.",
    disconnectOnError: false,
    writeComplete: false,
  };
  armOperationTimeout();
  try {
    log(`Sending read-only calculator information query: ${hex(INFORMATION_QUERY)}`);
    await state.transport.write(INFORMATION_QUERY);
    pending.writeComplete = true;
    if (state.pending === pending) log("Browser finished sending settings query (07); waiting for the calculator reply.");
  } catch (error) {
    if (state.pending === pending) failOperation(error, false);
  }
}

async function startTransfer({ decoder, command, label, status, timeoutMessage, logPackets = true, onComplete, onError }) {
  if (state.hp97s?.blocksNormalCommands || state.hp97sRecovery) throw new Error("Turn off the HP-97S interface before using normal calculator commands.");
  state.busy = true;
  setStatus(status);
  state.pending = {
    kind: "transfer",
    decoder,
    label,
    logPackets,
    onComplete,
    onError,
    timeoutMs: 8000,
    timeoutMessage,
    disconnectOnError: true,
  };
  armOperationTimeout();
  render();
  try {
    await sendPacket(command, label, true);
  } catch (error) {
    failOperation(error, true);
  }
}

function demoClockValue() {
  return new Date(state.demoClock.value.getTime() + performance.now() - state.demoClock.reference);
}

async function readClock(target = null) {
  if (elements.demo.checked) {
    state.clockReading = demoClockValue();
    state.clockVerified = true;
    elements.clockMessage.textContent = "Demo clock read successfully.";
    setStatus("Demo clock read successfully", "success");
    log(`Demo clock: ${state.clockReading.toLocaleString()}.`);
    render();
    return;
  }
  await startTransfer({
    decoder: new ClockReadTransfer(),
    command: Uint8Array.of(0x0f),
    label: "Clock",
    status: target ? "Verifying calculator clock…" : "Reading calculator clock…",
    timeoutMessage: "The calculator clock transfer timed out.",
    onComplete: async result => {
      state.clockReading = result.date;
      state.clockVerified = true;
      const verified = target && Math.abs(result.date.getTime() - target.getTime()) <= 5000;
      elements.clockMessage.textContent = target
        ? (verified ? "Clock set and verified by reading it back." : "Clock read back, but it differs from the requested time.")
        : "Clock read successfully.";
      setStatus(elements.clockMessage.textContent, verified === false ? "error" : "success");
      log(`Calculator clock: ${result.date.toLocaleString()}.`);
    },
  });
}

function localInputValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 19);
}

async function setClock() {
  const target = new Date(elements.clockInput.value);
  if (Number.isNaN(target.getTime())) {
    failOperation(new Error("Choose a valid date and time."), false);
    return;
  }
  if (elements.demo.checked) {
    state.demoClock = { value: target, reference: performance.now() };
    await readClock(target);
    return;
  }
  if (!window.confirm(`Set the calculator clock to ${target.toLocaleString()}?`)) return;
  await startTransfer({
    decoder: new ClockWriteTransfer(target),
    command: Uint8Array.of(0x0f),
    label: "Clock",
    status: "Setting calculator clock…",
    timeoutMessage: "The calculator clock write timed out.",
    onComplete: async () => {
      log("Calculator accepted the new date and time; reading it back.");
      await readClock(target);
    },
  });
}

async function readMemory() {
  if (elements.demo.checked) {
    state.memoryReading = readDemoMemory();
    elements.memoryMessage.textContent = "Demo active memory read complete · 448 bytes.";
    setStatus("Demo memory read successfully", "success");
    log("Decoded 448 Demo memory bytes, sixteen registers and 224 program positions.");
    render();
    return;
  }
  await startTransfer({
    decoder: new RAMReadTransfer(),
    command: Uint8Array.of(0x0c),
    label: "Memory",
    logPackets: false,
    status: "Reading 448 active memory bytes…",
    timeoutMessage: "The active-memory transfer timed out.",
    onComplete: async result => {
      result.capturedAt = new Date();
      result.simulated = false;
      state.memoryReading = result;
      elements.memoryMessage.textContent = "Calculator active memory read complete · 448 bytes.";
      setStatus("Calculator memory read successfully", "success");
      log("Received and decoded all 448 active memory bytes, sixteen registers and 224 program positions.");
    },
  });
}

async function openMemoryCapture(file) {
  if (locked()) return;
  state.busy = true;
  render();
  try {
    if (file.size > 32768) throw new Error("This file is too large for an HP-97 memory report.");
    const reading = loadMemoryReport(await file.text());
    state.memoryReading = { ...reading, fileName: file.name };
    elements.memoryMessage.textContent = `Opened ${file.name} · ${reading.simulated ? "DEMO · " : ""}448 bytes. Text reports have no checksum; all RAM rows and metadata were checked.`;
    setStatus("Saved memory capture opened", "success");
    log(`Opened memory report ${file.name}; no calculator command sent.`);
  } catch (error) {
    elements.memoryMessage.textContent = `${error.message} The previous memory view is unchanged.`;
    setStatus(error.message, "error");
    log(`Memory report rejected: ${error.message}`);
  } finally { state.busy = false; render(); }
}

function prepareProgram() {
  if (locked()) return;
  try {
    const cards = prepareMemoryCards(state.memoryReading, state.storedCapture, elements.programName.value);
    state.preparedProgram = { cards, memory: state.memoryReading, template: state.storedCapture, title: elements.programName.value };
    elements.programExportMessage.textContent = `${cards[0].simulated ? "DEMO · " : ""}All 224 positions verified. Save both files and load card 1 before card 2. Numeric registers are not included. Display settings and flags come from the template card.`;
    log("Prepared two HP-97 cards from the memory capture; program bytes and HPP round trips verified. No calculator command sent.");
  } catch (error) {
    state.preparedProgram = null;
    elements.programExportMessage.textContent = error.message;
  }
  render();
}

function readDemoMemory() {
  return { ...decodeRAM(state.demoMemory), simulated: true };
}

function readCurrentMemory() {
  if (elements.demo.checked) return Promise.resolve(readDemoMemory());
  return new Promise((resolve, reject) => {
    void startTransfer({ decoder: new RAMReadTransfer(), command: Uint8Array.of(0x0c), label: "Memory",
      status: "Reading current calculator memory…", timeoutMessage: "The active-memory transfer timed out.",
      logPackets: false, onComplete: resolve, onError: reject }).catch(reject);
  });
}

function reviewPairUpload() {
  if (elements.uploadPair.disabled || locked()) return;
  const program = state.preparedProgram;
  const block = Number(elements.storageBlock.value);
  const slot = Number(elements.storageSlot.value);
  validatePairLocation(block, slot);
  state.writeJob = { kind: "pair", block, slot, session: state.session, simulated: elements.demo.checked,
    memory: { bytes: program.memory.bytes.slice(), simulated: program.memory.simulated },
    cards: program.cards.map(card => ({ ...card, record: card.record.slice() })), started: false, writeStarted: false };
  elements.pairReview.textContent = `Upload “${program.cards[0].name}” and “${program.cards[1].name}” to ${elements.demo.checked ? "Demo " : ""}block ${block.toString(16).toUpperCase()}, slots ${String(slot).padStart(2, "0")} and ${String(slot + 1).padStart(2, "0")}? Both existing slots will be replaced. Current memory and both slots will be backed up first.`;
  elements.confirmPair.textContent = elements.demo.checked ? "Back up and upload Demo cards" : "Choose backup file and upload";
  elements.confirmPair.title = elements.demo.checked
    ? "Keep both destination backups and current memory in this Demo session, then write and verify both simulated slots."
    : "Choose a backup file, save and check both destination slots and active memory, then write and verify both cards.";
  render();
  elements.pairDialog.showModal();
}

async function confirmPairUpload() {
  const job = state.writeJob;
  if (job?.kind !== "pair" || job.started) return;
  job.started = true;
  elements.pairDialog.close();
  elements.pairMessage.textContent = job.simulated ? "Preparing Demo upload…" : "Choose a new backup file to start the upload…";
  render();
  const ensureConnected = () => {
    if (!state.connected || state.session !== job.session || state.writeJob !== job || state.closing ||
        elements.demo.checked !== job.simulated || !verifiedFirmware()) throw new Error("The connection changed. Upload stopped.");
  };
  try {
    ensureConnected();
    // Keep the user gesture for the picker; no calculator request precedes it.
    const handle = job.simulated ? null : await window.showSaveFilePicker({
      suggestedName: `Teenio-program-backup-${job.block.toString(16).toUpperCase()}-${String(job.slot).padStart(2, "0")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      types: [{ description: "Teenio two-card backup", accept: { "application/json": [".json"] } }],
    });
    ensureConnected();
    const result = await uploadProgramPair({ ...job, ensureConnected,
      readMemory: readCurrentMemory,
      readSlot: (block, slot) => job.simulated ? demoStoredSlot(block, slot)
        : runStorageTransfer(new StoredSlotReadTransfer(block, slot), 0x03, "Reading stored slot…"),
      writeSlot: (block, slot, bytes) => job.simulated ? writeDemoSlot(block, slot, bytes)
        : runStorageTransfer(new StoredSlotWriteTransfer(block, slot, bytes), 0x04, "Writing stored card…"),
      saveBackup: text => job.simulated ? Promise.resolve(text) : saveBackupFile(handle, text),
      onBackup: backup => { state.lastPairBackup = backup; },
      onWriteStart: () => {
        ensureConnected();
        job.writeStarted = true;
        state.programLoad = null;
        state.directoryEntries = null;
        elements.directoryMessage.textContent = "Scan the directory again after the upload.";
      },
      onStage: message => { elements.pairMessage.textContent = message; setStatus(message); log(`${job.simulated ? "Demo · " : ""}${message}`); },
    });
    ensureConnected();
    state.programLoad = result;
    elements.verificationMessage.textContent = "Cards verified in storage. Load both on the calculator before verifying active memory. Do not run the program or change registers before verification.";
    elements.pairMessage.textContent = `Both cards uploaded and all 300 bytes checked. ${job.simulated ? "Save the Demo backup below to retain it." : `Backup saved as ${handle.name}.`} Loading is a separate step below.`;
    if (job.simulated) {
      state.directoryBlock = job.block;
      state.directoryEntries = demoDirectory(job.block);
      elements.directoryMessage.textContent = "Demo directory updated after the verified upload.";
    }
    setStatus("Both stored cards uploaded and verified", "success");
    log(elements.pairMessage.textContent);
  } catch (error) {
    const message = `${error.name === "AbortError" && !job.writeStarted ? "Upload cancelled." : error.message} ${job.writeStarted ? "The pair may be incomplete. Keep the backup; no retry or restore was attempted." : "No calculator write was started."}`;
    elements.pairMessage.textContent = message;
    setStatus(message, "error");
    log(message);
    if (job.writeStarted && !job.simulated && state.connected) await disconnect(message);
  } finally { state.writeJob = null; state.busy = false; render(); }
}

async function verifyLoadedProgram() {
  if (elements.verifyProgram.disabled || locked()) return;
  const load = state.programLoad;
  const session = state.session;
  state.verifying = true;
  load.report = null;
  elements.verificationMessage.textContent = "Reading active memory to compare the program and registers…";
  render();
  try {
    const after = await readCurrentMemory();
    if (!state.connected || state.session !== session || state.programLoad !== load) throw new Error("The connection changed. Verification was not completed.");
    const result = compareLoadedProgram(load.before, load.expectedProgram, after.bytes);
    state.memoryReading = after;
    elements.memoryMessage.textContent = "Memory read during loaded-program verification.";
    elements.verificationMessage.textContent = result.message;
    load.report = [`Teenio loaded-program verification`, `Source: ${load.simulated ? "DEMO EXAMPLE" : "Bluetooth calculator read"}`,
      `Checked: ${after.capturedAt.toISOString()}`, `Storage block ${load.block.toString(16).toUpperCase()}, slots ${load.slot} and ${load.slot + 1}`,
      result.message, "", "Memory after verification", memoryReport(after)].join("\n");
    setStatus(result.message, result.verified ? "success" : result.programMatches && !result.changedRegisters.length ? "neutral" : "error");
    log(result.message);
  } catch (error) { elements.verificationMessage.textContent = error.message; setStatus(error.message, "error"); log(error.message); }
  finally { state.verifying = false; render(); }
}

function simulateProgramLoad() {
  if (elements.simulateLoad.disabled || !elements.demo.checked || !state.programLoad?.simulated || locked()) return;
  const load = state.programLoad;
  try {
    const program = programBytesFromCards([demoStoredSlot(load.block, load.slot), demoStoredSlot(load.block, load.slot + 1)]);
    state.demoMemory.set(program, 112);
    load.report = null;
    elements.verificationMessage.textContent = "Demo calculator loaded both stored cards. Choose Verify loaded program for a separate memory read.";
    log("Demo calculator loaded the stored pair; sixteen registers preserved. Verification has not yet run.");
    render();
  } catch (error) { elements.verificationMessage.textContent = error.message; }
}

async function openPairBackup(file) {
  if (locked()) return;
  state.busy = true;
  render();
  try {
    if (file.size > 65536) throw new Error("This file is too large for a two-card backup.");
    state.lastPairBackup = await loadProgramBackup(await file.text());
    elements.pairMessage.textContent = "Backup opened and checked. Use the backup tools to save its individual captures. Opening it does not restore any calculator data.";
  } catch (error) { elements.pairMessage.textContent = error.message; }
  finally { state.busy = false; render(); }
}

async function scanDirectory() {
  const block = Number(elements.storageBlock.value);
  if (elements.demo.checked) {
    state.directoryEntries = demoDirectory(block);
    state.directoryBlock = block;
    const occupied = state.directoryEntries.filter(Boolean).length;
    elements.directoryMessage.textContent = `Demo block ${block.toString(16).toUpperCase()} directory read complete · ${occupied} occupied, ${54 - occupied} vacant.`;
    setStatus("Demo directory read successfully", "success");
    log(`Decoded Demo block ${block.toString(16).toUpperCase()} directory with ${occupied} occupied slots.`);
    render();
    return;
  }
  await startTransfer({
    decoder: new DirectoryTransfer(block),
    command: Uint8Array.of(0x06),
    label: "Directory",
    logPackets: false,
    status: `Scanning storage block ${block.toString(16).toUpperCase()}…`,
    timeoutMessage: "The stored-program directory transfer timed out.",
    onComplete: async entries => {
      state.directoryEntries = entries;
      state.directoryBlock = block;
      const occupied = entries.filter(Boolean).length;
      elements.directoryMessage.textContent = `Block ${block.toString(16).toUpperCase()} directory read complete · ${occupied} occupied, ${54 - occupied} vacant.`;
      setStatus("Stored-program directory read successfully", "success");
      log(`Block ${block.toString(16).toUpperCase()} directory complete: ${occupied} occupied and ${54 - occupied} vacant slots.`);
    },
  });
}

async function readStoredSlot() {
  const block = Number(elements.storageBlock.value);
  const slot = Number(elements.storageSlot.value);
  const finish = async (bytes, simulated) => {
    state.storedCapture = await makeStoredCapture(block, slot, bytes, simulated);
    const location = `block ${block.toString(16).toUpperCase()} slot ${String(slot).padStart(2, "0")}`;
    elements.storageMessage.textContent = `${simulated ? "Demo" : "Calculator"} ${location} read complete · 150 bytes received and SHA-256 calculated.`;
    setStatus(`${simulated ? "Demo" : "Stored"} program card read successfully`, "success");
    log(`Read ${location}: 150 bytes · SHA-256 ${state.storedCapture.sha256}.`);
  };
  if (elements.demo.checked) {
    await finish(demoStoredSlot(block, slot), true);
    render();
    return;
  }
  await startTransfer({
    decoder: new StoredSlotReadTransfer(block, slot),
    command: Uint8Array.of(0x03),
    label: "Stored slot",
    logPackets: false,
    status: `Reading block ${block.toString(16).toUpperCase()} slot ${String(slot).padStart(2, "0")}…`,
    timeoutMessage: "The stored-slot transfer timed out.",
    onComplete: async bytes => finish(bytes, false),
  });
}

async function openStoredCapture(file) {
  if (locked()) return;
  state.busy = true;
  render();
  try {
    state.storedCapture = await loadStoredCapture(await file.text());
    elements.storageMessage.textContent = `Opened ${file.name}; its 150 bytes passed the saved integrity check.`;
    setStatus("Stored capture opened successfully", "success");
    log(`Opened stored capture ${file.name} · SHA-256 ${state.storedCapture.sha256}.`);
  } catch (error) {
    setStatus(error.message, "error");
    elements.storageMessage.textContent = error.message;
    log(`Stored capture rejected: ${error.message}`);
  }
  state.busy = false;
  render();
}

async function openHPPProgram(file) {
  if (locked()) return;
  state.busy = true;
  render();
  try {
    const imported = decodeHPP(new Uint8Array(await file.arrayBuffer()));
    const capture = await makeStoredCapture(0, 0, imported.record, false);
    capture.importedHPP = true;
    state.storedCapture = capture;
    elements.storageMessage.textContent = `Opened ${file.name}; HP-97 card checksum and structure verified.`;
    setStatus("HP-97 program card opened successfully", "success");
    log(`Imported HP-97 card ${imported.name || "(unnamed)"} from ${file.name}.`);
  } catch (error) {
    setStatus(error.message, "error");
    elements.storageMessage.textContent = error.message;
    log(`HP-97 card rejected: ${error.message}`);
  }
  state.busy = false;
  render();
}

function runStorageTransfer(decoder, command, status) {
  return new Promise((resolve, reject) => {
    void startTransfer({ decoder, command: Uint8Array.of(command), label: "Stored slot", status,
      timeoutMessage: "The stored-slot transfer timed out. Keep the destination backup.",
      logPackets: false, onComplete: resolve, onError: reject }).catch(reject);
  });
}

function reviewSlotWrite() {
  if (elements.writeSlot.disabled || locked()) return;
  const job = {
    block: Number(elements.storageBlock.value), slot: Number(elements.storageSlot.value),
    source: { ...state.storedCapture, bytes: state.storedCapture.bytes.slice() },
    simulated: elements.demo.checked, session: state.session, started: false, writeStarted: false,
  };
  state.writeJob = job;
  elements.writeReview.textContent = `Write “${job.source.name || "Unnamed card"}” to ${job.simulated ? "Demo " : ""}block ${job.block.toString(16).toUpperCase()}, slot ${String(job.slot).padStart(2, "0")}? Any existing card in this destination will be replaced. This writes one stored card; it does not load active program memory.`;
  elements.writeConfirm.textContent = job.simulated ? "Back up and write Demo slot" : "Choose backup file and write";
  elements.writeConfirm.title = job.simulated
    ? "Keep the original slot in this Demo session, then write and verify the simulated destination. Save a backup copy to retain it."
    : "Choose a backup file, save and check the destination’s original contents, then write and verify the current card.";
  render();
  elements.writeDialog.showModal();
}

async function confirmSlotWrite() {
  const job = state.writeJob;
  if (!job || job.started) return;
  job.started = true;
  elements.writeDialog.close();
  const location = `block ${job.block.toString(16).toUpperCase()}, slot ${String(job.slot).padStart(2, "0")}`;
  const ensureConnected = () => {
    if (!state.connected || state.session !== job.session || state.writeJob !== job || state.closing ||
        elements.demo.checked !== job.simulated || !verifiedFirmware()) {
      throw new Error("The connection changed. The write cannot continue.");
    }
  };
  try {
    ensureConnected();
    // Request the file from the user's click before awaiting any calculator IO.
    const handle = job.simulated ? null : await window.showSaveFilePicker({
      suggestedName: `Teenio-backup-${job.block.toString(16).toUpperCase()}-${String(job.slot).padStart(2, "0")}-${new Date().toISOString().replace(/[:.]/g, "-")}.calcom-slot`,
      // Keep the native-compatible filename, but omit the type filter: the File
      // System Access API forbids hyphens in accept suffixes, not in filenames.
      // https://wicg.github.io/file-system-access/#valid-suffix-code-point
    });
    ensureConnected();
    const result = await writeBackedUpSlot({ ...job, ensureConnected,
      read: (block, slot) => job.simulated ? demoStoredSlot(block, slot)
        : runStorageTransfer(new StoredSlotReadTransfer(block, slot), 0x03, "Reading stored slot…"),
      write: async (block, slot, bytes) => {
        ensureConnected();
        job.writeStarted = true;
        state.programLoad = null;
        // A scan is stale as soon as a write is attempted, including a failed write.
        state.directoryEntries = null;
        elements.directoryMessage.textContent = "Scan the block again to refresh its directory after this write.";
        if (job.simulated) writeDemoSlot(block, slot, bytes);
        else await runStorageTransfer(new StoredSlotWriteTransfer(block, slot, bytes), 0x04, "Writing stored slot…");
      },
      saveBackup: text => job.simulated ? Promise.resolve(text) : saveBackupFile(handle, text),
      onBackup: backup => { state.lastBackup = backup; },
      onStage: message => {
        elements.storageMessage.textContent = message;
        setStatus(message);
        log(`${job.simulated ? "Demo · " : ""}${location}: ${message}`);
      },
    });
    state.storedCapture = result.capture;
    if (job.simulated) {
      state.directoryBlock = job.block;
      state.directoryEntries = demoDirectory(job.block);
      elements.directoryMessage.textContent = "Demo directory updated after the verified write.";
    }
    elements.storageMessage.textContent = `${job.simulated ? "Demo " : ""}${location}: write complete; all 150 bytes match the source. ${job.simulated ? "The Demo backup is available below." : `Backup saved as ${handle.name}.`}`;
    setStatus("Stored card written and verified", "success");
    log(elements.storageMessage.textContent);
  } catch (error) {
    const message = error.name === "AbortError" && !job.writeStarted
      ? "Writing cancelled. No write was started."
      : `${error.message} ${job.writeStarted ? "The destination may have changed. Keep its backup; no automatic retry was made." : "No write was started."}`;
    elements.storageMessage.textContent = message;
    setStatus(message, "error");
    log(message);
    if (job.writeStarted && !job.simulated && state.connected) await disconnect(message);
  } finally {
    state.writeJob = null;
    state.busy = false;
    render();
  }
}

function download(name, contents) {
  downloadBlob(name, new Blob([contents], { type: "text/plain;charset=utf-8" }));
}

function downloadBlob(name, blob) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function safeFilename(name, fallback) {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback;
}

elements.connect.addEventListener("click", () => state.connected ? void userDisconnect() : void connect());
elements.hp97sToggle.addEventListener("click", () => void hp97sAction("toggle"));
elements.hp97sReadStatus.addEventListener("click", () => void hp97sAction("status"));
elements.hp97sDigits.addEventListener("input", renderHP97S);
elements.hp97sSend.addEventListener("click", reviewHP97SSend);
elements.hp97sConfirm.addEventListener("click", () => void confirmHP97SSend());
elements.hp97sCancel.addEventListener("click", () => elements.hp97sSendDialog.close());
elements.hp97sSendDialog.addEventListener("close", () => { state.hp97sReview = null; render(); });
elements.hp97sClearLog.addEventListener("click", () => { state.hp97sLogs = []; elements.hp97sLog.textContent = ""; renderHP97S(); });
elements.hp97sSaveLog.addEventListener("click", () => download(`Teenio-${elements.demo.checked ? "Demo-" : ""}HP97S.log.txt`, `${state.hp97sLogs.join("\n")}\n`));
elements.hp97sRecovered.addEventListener("click", () => {
  if (state.connected || baseLocked()) return;
  state.hp97sRecovery = false;
  try { sessionStorage.removeItem("teenio.hp97sRecovery"); } catch { /* Storage can be unavailable. */ }
  elements.hp97sMessage.textContent = elements.demo.checked ? "Demo interface reset. Reconnect to continue." : "Recovery acknowledged. Reconnect and read settings before enabling HP-97S again.";
  render();
});
document.querySelectorAll("[data-hp97s-key]").forEach(button => button.addEventListener("click", () => {
  if (elements.hp97sDigits.disabled) return;
  const field = elements.hp97sDigits;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(button.dataset.hp97sKey, start, end, "end");
  field.focus();
  renderHP97S();
}));
document.querySelectorAll("[data-hp97s-flag]").forEach(button => button.addEventListener("click", () => {
  if (!elements.demo.checked || baseLocked() || state.hp97s?.mode !== "on" || state.hp97s.busy) return;
  state.hp97s.receive(state.hp97sDemo.toggleFlag(Number(button.dataset.hp97sFlag)));
}));
elements.readSettings.addEventListener("click", () => void readSettings());
elements.readClock.addEventListener("click", () => void readClock());
elements.setClock.addEventListener("click", () => void setClock());
elements.useComputerTime.addEventListener("click", () => { elements.clockInput.value = localInputValue(new Date()); });
elements.readMemory.addEventListener("click", () => void readMemory());
elements.openMemory.addEventListener("click", () => elements.memoryFile.click());
elements.memoryFile.addEventListener("change", () => {
  const [file] = elements.memoryFile.files;
  if (file) void openMemoryCapture(file);
  elements.memoryFile.value = "";
});
elements.chooseTemplate.addEventListener("click", () => showPage("programs"));
elements.chooseUploadDestination.addEventListener("click", () => showPage("programs"));
elements.prepareForUpload.addEventListener("click", () => showPage("memory"));
elements.prepareProgram.addEventListener("click", prepareProgram);
elements.programName.addEventListener("input", () => { renderProgramExport(); renderPairUpload(); });
for (let part = 1; part <= 2; part += 1) {
  elements[`exportPart${part}`].addEventListener("click", () => {
    if (locked() || !state.preparedProgram) return;
    const card = state.preparedProgram.cards[part - 1];
    const name = `${card.simulated ? "DEMO-" : ""}${safeFilename(state.preparedProgram.title, "HP97-program")}-card-${part}.hpp`;
    downloadBlob(name, new Blob([card.hpp], { type: "application/octet-stream" }));
    elements.programExportMessage.textContent = `Download requested: ${name}. Keep both files together; load card 1 before card 2. Numeric registers are not included.`;
  });
}
elements.scanDirectory.addEventListener("click", () => void scanDirectory());
elements.readSlot.addEventListener("click", () => void readStoredSlot());
elements.writeSlot.addEventListener("click", reviewSlotWrite);
elements.uploadPair.addEventListener("click", reviewPairUpload);
elements.confirmPair.addEventListener("click", () => void confirmPairUpload());
elements.cancelPair.addEventListener("click", () => elements.pairDialog.close());
elements.pairDialog.addEventListener("close", () => {
  if (state.writeJob?.kind === "pair" && !state.writeJob.started) { state.writeJob = null; render(); }
});
elements.verifyProgram.addEventListener("click", () => void verifyLoadedProgram());
elements.simulateLoad.addEventListener("click", simulateProgramLoad);
elements.saveVerification.addEventListener("click", () => {
  if (state.programLoad?.report) download("Teenio-program-verification.txt", state.programLoad.report);
});
elements.openPairBackup.addEventListener("click", () => elements.pairBackupFile.click());
elements.pairBackupFile.addEventListener("change", () => {
  const [file] = elements.pairBackupFile.files;
  if (file) void openPairBackup(file);
  elements.pairBackupFile.value = "";
});
elements.savePairBackup.addEventListener("click", () => {
  const backup = state.lastPairBackup;
  if (backup) download(`Teenio-${backup.simulated ? "Demo-" : ""}program-backup-${backup.block.toString(16).toUpperCase()}-${String(backup.slot).padStart(2, "0")}.json`, encodeProgramBackup(backup));
});
elements.extractPairMemory.addEventListener("click", () => {
  if (state.lastPairBackup) download("Teenio-before-upload-memory.txt", memoryReport(state.lastPairBackup.memory));
});
for (let part = 1; part <= 2; part += 1) {
  elements[`extractPairSlot${part}`].addEventListener("click", () => {
    const capture = state.lastPairBackup?.slots[part - 1];
    if (capture) download(`Teenio-backup-${capture.block.toString(16).toUpperCase()}-${String(capture.slot).padStart(2, "0")}.calcom-slot`, encodeStoredCapture(capture));
  });
}
elements.writeConfirm.addEventListener("click", () => void confirmSlotWrite());
elements.cancelWrite.addEventListener("click", () => elements.writeDialog.close());
elements.writeDialog.addEventListener("close", () => {
  if (state.writeJob && !state.writeJob.started) { state.writeJob = null; render(); }
});
elements.saveBackup.addEventListener("click", () => {
  const backup = state.lastBackup;
  if (backup) download(`Teenio-${backup.simulated ? "Demo-" : ""}backup-${backup.block.toString(16).toUpperCase()}-${String(backup.slot).padStart(2, "0")}.calcom-slot`, encodeStoredCapture(backup));
});
elements.storageBlock.addEventListener("change", () => renderStorage());
elements.storageSlot.addEventListener("change", updateSlotSelection);
elements.directoryGrid.addEventListener("click", event => {
  const entry = event.target.closest("button[data-slot]");
  if (!entry || locked()) return;
  elements.storageSlot.value = entry.dataset.slot;
  // Update in place so clicking a lower slot keeps the directory's scroll and focus.
  updateSlotSelection();
});
elements.openCapture.addEventListener("click", () => elements.captureFile.click());
elements.openHPP.addEventListener("click", () => elements.hppFile.click());
elements.captureFile.addEventListener("change", () => {
  const [file] = elements.captureFile.files;
  if (file) void openStoredCapture(file);
  elements.captureFile.value = "";
});
elements.hppFile.addEventListener("change", () => {
  const [file] = elements.hppFile.files;
  if (file) void openHPPProgram(file);
  elements.hppFile.value = "";
});
elements.demo.addEventListener("change", async () => {
  if (state.connected) await disconnect();
  state.programLoad = null;
  resetReadings();
  setStatus(elements.demo.checked ? "Demo mode selected" : "Ready to connect");
  render();
});
elements.saveSettings.addEventListener("click", () => download("Teenio-Web-settings.txt", settingsReport(state.reading)));
elements.saveMemory.addEventListener("click", () => download("Teenio-Web-current-memory.txt", memoryReport(state.memoryReading)));
elements.saveListing.addEventListener("click", () => download("Teenio-Web-program-listing.txt", programReport(state.memoryReading)));
elements.saveCapture.addEventListener("click", () => {
  const capture = state.storedCapture;
  const name = safeFilename(capture.name, `block-${capture.block.toString(16).toUpperCase()}-slot-${String(capture.slot).padStart(2, "0")}`);
  download(`${name}.calcom-slot`, encodeStoredCapture(capture));
});
elements.exportHPP.addEventListener("click", () => {
  const capture = state.storedCapture;
  const name = safeFilename(capture.name, "HP97-program");
  try {
    downloadBlob(`${name}.hpp`, new Blob([encodeHPP(capture.bytes)], { type: "application/octet-stream" }));
    elements.storageMessage.textContent = "HP-97 card exported; the title, program data and checksum were verified by reopening the export.";
  } catch (error) { setStatus(error.message, "error"); }
});
elements.saveLog.addEventListener("click", () => download("Teenio-Web-activity.log.txt", `${state.logs.join("\n")}\n`));
elements.clearLog.addEventListener("click", () => { state.logs = []; elements.activity.textContent = ""; render(); });
elements.helpButton.addEventListener("click", () => elements.help.showModal());
elements.closeHelp.addEventListener("click", () => elements.help.close());
elements.install.addEventListener("click", async () => {
  if (!state.installPrompt) return;
  await state.installPrompt.prompt();
  state.installPrompt = null;
  elements.install.hidden = true;
});
document.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll("[data-memory-view]").forEach(button => button.addEventListener("click", () => {
  state.memoryView = button.dataset.memoryView;
  renderMemory();
}));

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  state.installPrompt = event;
  elements.install.hidden = false;
});
window.addEventListener("appinstalled", () => { elements.install.hidden = true; log("Teenio Web installed."); });
window.addEventListener("beforeunload", event => {
  if (state.writeJob?.started || state.hp97s?.blocksNormalCommands) {
    event.preventDefault();
    event.returnValue = "";
  } else if (state.connected && !elements.demo.checked) void state.transport?.disconnect();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(error => log(`Offline setup failed: ${error.message}`));
if (!WebSerialTransport.supported()) elements.compatibility.hidden = false;

for (let block = 0; block < 15; block += 1) {
  const option = document.createElement("option");
  option.value = String(block);
  option.textContent = block.toString(16).toUpperCase();
  elements.storageBlock.append(option);
}
for (let slot = 0; slot < 54; slot += 1) {
  const option = document.createElement("option");
  option.value = String(slot);
  option.textContent = String(slot).padStart(2, "0");
  elements.storageSlot.append(option);
}
elements.clockInput.value = localInputValue(new Date());
showPage("settings");
setStatus("Ready to connect");
log("Teenio Web ready. Pair TEENIX97 in the operating system before connecting.");
render();
