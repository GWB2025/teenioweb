export class StorageError extends Error {}

function validateLocation(block, slot = 0) {
  if (!Number.isInteger(block) || block < 0 || block > 14 ||
      !Number.isInteger(slot) || slot < 0 || slot > 53) {
    throw new StorageError("Choose a storage block from 0 to E and a slot from 00 to 53.");
  }
}

function slotBCD(slot) {
  return Math.floor(slot / 10) * 16 + slot % 10;
}

function printableName(bytes) {
  const name = Array.from(bytes.slice(1, 21)).filter(byte => byte >= 0x20 && byte <= 0x7e);
  return new TextDecoder("ascii").decode(Uint8Array.from(name)).trim();
}

export class DirectoryTransfer {
  constructor(block) {
    validateLocation(block);
    this.block = block;
    this.phase = "command";
    this.entries = [];
    this.record = [];
  }

  append(chunk) {
    const packets = [];
    let complete = false;
    for (const byte of chunk) {
      if (byte === 0xae && this.phase !== "record") {
        throw new StorageError("The calculator reported a storage-directory access error.");
      }
      switch (this.phase) {
        case "command":
          if (byte !== 0x06) throw new StorageError("The storage-directory response was incomplete or unexpected.");
          this.phase = "block";
          packets.push(Uint8Array.of(this.block, 0x00));
          break;
        case "block":
          if (byte !== 0x06) throw new StorageError("The storage-directory response was incomplete or unexpected.");
          this.phase = "slot";
          packets.push(Uint8Array.of(0x00));
          break;
        case "slot":
          if (byte === 0xff) {
            this.entries.push(null);
            this.queueNext(packets);
          } else if (byte === 0x06) {
            this.record = [];
            this.phase = "record";
            packets.push(Uint8Array.of(0x06));
          } else {
            throw new StorageError("The storage-directory response was incomplete or unexpected.");
          }
          break;
        case "record":
          this.record.push(byte);
          if (this.record.length === 28) {
            const bytes = Uint8Array.from(this.record);
            this.entries.push({ slot: this.entries.length, name: printableName(bytes), typeByte: bytes[0], bytes });
            this.queueNext(packets);
          }
          break;
        case "finish":
          if (byte !== 0x06) throw new StorageError("The storage-directory response was incomplete or unexpected.");
          this.phase = "done";
          complete = true;
          break;
        default:
          throw new StorageError("The calculator sent data after completing the directory transfer.");
      }
    }
    return { packets, complete, result: complete ? this.entries.slice() : null };
  }

  queueNext(packets) {
    if (this.entries.length === 54) {
      this.phase = "finish";
      packets.push(Uint8Array.of(0xff));
    } else {
      this.phase = "block";
      packets.push(Uint8Array.of(0x06));
    }
  }
}

export class StoredSlotReadTransfer {
  constructor(block, slot) {
    validateLocation(block, slot);
    this.block = block;
    this.slot = slot;
    this.address = Uint8Array.of(block, slotBCD(slot));
    this.phase = "initial";
    this.bytes = [];
    this.remaining = 0;
  }

  append(chunk) {
    const packets = [];
    let complete = false;
    for (const byte of chunk) {
      switch (this.phase) {
        case "initial":
          if (byte !== 0x03) throw new StorageError("The calculator sent an unexpected stored-slot reply.");
          this.phase = "ready";
          packets.push(this.address);
          break;
        case "ready":
          if (byte !== 0x03) throw new StorageError("The calculator sent an unexpected stored-slot reply.");
          this.phase = "chunk";
          this.remaining = 10;
          packets.push(Uint8Array.of(0xee));
          break;
        case "chunk":
          this.bytes.push(byte);
          this.remaining -= 1;
          if (this.remaining === 0) {
            if (this.bytes.length === 150) {
              this.phase = "completion";
              packets.push(Uint8Array.of(0xff));
            } else if (this.bytes.length < 150) {
              this.remaining = 10;
              packets.push(Uint8Array.of(0xee));
            } else {
              throw new StorageError("The stored-slot reply exceeded 150 bytes.");
            }
          }
          break;
        case "completion":
          if (byte !== 0x03) throw new StorageError("The calculator sent an unexpected stored-slot completion reply.");
          this.phase = "done";
          complete = true;
          break;
        default:
          throw new StorageError("The calculator sent data after completing the stored-slot transfer.");
      }
    }
    return { packets, complete, result: complete ? Uint8Array.from(this.bytes) : null };
  }
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new StorageError("The stored capture contains invalid byte data.");
  }
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function makeStoredCapture(block, slot, bytes, simulated = false, capturedAt = new Date()) {
  validateLocation(block, slot);
  if (bytes.length !== 150) throw new StorageError("A complete stored slot must contain 150 bytes.");
  const payload = Uint8Array.from(bytes);
  return {
    format: "CalCom stored slot v1",
    firmware: 21,
    block,
    slot,
    capturedAt,
    simulated,
    bytes: payload,
    sha256: await sha256(payload),
    name: printableName(payload),
  };
}

export function encodeStoredCapture(capture) {
  const referenceDate = Date.UTC(2001, 0, 1);
  const json = {
    block: capture.block,
    bytes: base64(capture.bytes),
    capturedAt: (capture.capturedAt.getTime() - referenceDate) / 1000,
    firmware: 21,
    format: "CalCom stored slot v1",
    sha256: capture.sha256,
    simulated: capture.simulated,
    slot: capture.slot,
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

export async function loadStoredCapture(text) {
  if (text.startsWith("HP-97 active RAM capture")) {
    throw new StorageError("This is an active-memory report. Use Memory & registers → Open memory capture… to view it and prepare program cards.");
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new StorageError("This is not a valid Teenio stored-slot capture."); }
  if (!json || typeof json.bytes !== "string" || typeof json.simulated !== "boolean" ||
      typeof json.capturedAt !== "number" || !Number.isFinite(json.capturedAt)) {
    throw new StorageError("The stored-slot capture has invalid metadata.");
  }
  validateLocation(json.block, json.slot);
  const bytes = fromBase64(json.bytes);
  if (json.format !== "CalCom stored slot v1" || json.firmware !== 21 || bytes.length !== 150 ||
      typeof json.sha256 !== "string" || await sha256(bytes) !== json.sha256) {
    throw new StorageError("The stored-slot capture is damaged or failed its integrity check.");
  }
  const referenceDate = Date.UTC(2001, 0, 1);
  const capturedAt = new Date(referenceDate + Number(json.capturedAt) * 1000);
  if (Number.isNaN(capturedAt.getTime())) throw new StorageError("The stored capture has an invalid date.");
  return makeStoredCapture(json.block, json.slot, bytes, json.simulated, capturedAt);
}

function word(nibbles) {
  return nibbles.reduce((sum, value, index) => sum + value * (16 ** index), 0);
}

export function validateProgramCard(record) {
  if (isVacantSlot(record)) throw new StorageError("This slot is vacant; there is no program card to export or write.");
  // 61 was observed in the verified block-8/49 TEENIX97 capture. Its card body
  // matches the original HPP exactly; HPP itself has no storage-marker field.
  if (record.length !== 150 || ![0x43, 0x61].includes(record[0]) || Array.from(record.slice(140)).some(byte => byte !== 0xff)) {
    throw new StorageError("This stored slot is not a complete HP-97 program card.");
  }
  const title = Array.from(record.slice(1, 21));
  const end = title.indexOf(0xff);
  const nameBytes = end < 0 ? title : title.slice(0, end);
  if (nameBytes.some(byte => byte < 0x20 || byte > 0x7e) ||
      (end >= 0 && title.slice(end).some(byte => byte !== 0xff))) {
    throw new StorageError("The HP-97 program-card title is invalid.");
  }
  const nibbles = Array.from(record.slice(21, 140)).flatMap(byte => [byte >> 4, byte & 0x0f]);
  const header = nibbles.slice(0, 7);
  if (![3, 4].includes(header[6]) || header[5] > 1 || header[3] > 2) {
    throw new StorageError("The HP-97 program-card header is invalid.");
  }
  let checksum = 0;
  for (let offset = 0; offset < 231; offset += 7) checksum = (checksum + word(nibbles.slice(offset, offset + 7))) & 0x0fffffff;
  if (checksum !== word(nibbles.slice(231, 238))) throw new StorageError("The HP-97 program-card checksum is invalid.");
  return { header, name: new TextDecoder().decode(Uint8Array.from(nameBytes)), marker: record[0] };
}

export function isVacantSlot(record) {
  return record.length === 150 && record.every(byte => byte === 0xff);
}

export function decodeHPP(fileBytes) {
  const decoded = Uint8Array.from(fileBytes, byte => byte ^ 0x55);
  const text = new TextDecoder("latin1").decode(decoded);
  const first = text.indexOf("\r");
  const second = text.indexOf("\r", first + 1);
  if (first < 0 || second < 0 || text.slice(0, first) !== "NeWe") throw new StorageError("This is not a complete HP-97 .hpp program card.");
  const length = Number(text.slice(first + 1, second));
  const body = text.slice(second + 1);
  if (!/^\d+$/.test(text.slice(first + 1, second)) || !Number.isInteger(length) || length !== body.length) throw new StorageError("This is not a complete HP-97 .hpp program card.");
  const lines = body.split("\r\n");
  if (lines.length !== 270 || lines[269] !== "" || lines[0] !== "97" || lines[1] !== "") throw new StorageError("This is not an HP-97 .hpp program card.");
  const name = lines[2];
  if (name.length > 20 || Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126)) {
    throw new StorageError("The .hpp card name is invalid.");
  }
  const numbers = lines.slice(3, 269).map(value => Number(value));
  if (lines.slice(3, 269).some(value => !/^\d+$/.test(value)) || numbers.length !== 266 || numbers.some(value => !Number.isInteger(value) || value < 0 || value > 15) ||
      numbers.slice(0, 21).some(value => value !== 0) ||
      numbers.slice(252, 259).some((value, index) => value !== numbers[259 + index])) {
    throw new StorageError("This is not a complete HP-97 .hpp program card.");
  }
  const nibbles = numbers.slice(21, 259);
  const record = [0x43, ...new TextEncoder().encode(name), ...Array(20 - name.length).fill(0xff)];
  for (let offset = 0; offset < 238; offset += 2) record.push(nibbles[offset] << 4 | nibbles[offset + 1]);
  record.push(...Array(10).fill(0xff));
  const bytes = Uint8Array.from(record);
  validateProgramCard(bytes);
  return { name, record: bytes };
}

export function encodeHPP(record) {
  const { name } = validateProgramCard(record);
  const nibbles = Array.from(record.slice(21, 140)).flatMap(byte => [byte >> 4, byte & 0x0f]);
  const numbers = [...Array(21).fill(0), ...nibbles, ...nibbles.slice(-7)];
  const body = ["97", "", name, ...numbers.map(String)].join("\r\n") + "\r\n";
  const plain = `NeWe\r${new TextEncoder().encode(body).length}\r${body}`;
  const encoded = Uint8Array.from(new TextEncoder().encode(plain), byte => byte ^ 0x55);
  // HPP imports reconstruct marker 43; all 149 remaining bytes must be exact.
  if (!decodeHPP(encoded).record.every((byte, index) => byte === (index === 0 ? 0x43 : record[index]))) {
    throw new StorageError("The HP-97 .hpp export could not be verified.");
  }
  return encoded;
}

function encodeDemoCard(name) {
  const header = [2, 2, 2, 0, 0, 1, 3];
  const nibbles = [...header, ...Array(224).fill(0)];
  let checksum = 0;
  for (let offset = 0; offset < 231; offset += 7) checksum = (checksum + word(nibbles.slice(offset, offset + 7))) & 0x0fffffff;
  nibbles.push(...Array.from({ length: 7 }, (_, index) => (checksum >> (4 * index)) & 0x0f));
  const record = [0x43, ...new TextEncoder().encode(name), ...Array(20 - name.length).fill(0xff)];
  for (let offset = 0; offset < 238; offset += 2) record.push(nibbles[offset] << 4 | nibbles[offset + 1]);
  record.push(...Array(10).fill(0xff));
  return Uint8Array.from(record);
}

const DEMO_CARDS = new Map([
  ["0:0", encodeDemoCard("Example calculation")],
  ["0:1", encodeDemoCard("Example conversion")],
]);

export function demoDirectory(block) {
  validateLocation(block);
  return Array.from({ length: 54 }, (_, slot) => {
    const bytes = DEMO_CARDS.get(`${block}:${slot}`);
    return bytes ? { slot, name: printableName(bytes), typeByte: bytes[0], bytes: bytes.slice(0, 28) } : null;
  });
}

export function demoStoredSlot(block, slot) {
  validateLocation(block, slot);
  return Uint8Array.from(DEMO_CARDS.get(`${block}:${slot}`) ?? new Uint8Array(150).fill(0xff));
}

export function writeDemoSlot(block, slot, bytes) {
  validateLocation(block, slot);
  validateProgramCard(bytes);
  DEMO_CARDS.set(`${block}:${slot}`, Uint8Array.from(bytes));
}

export class StoredSlotWriteTransfer {
  constructor(block, slot, bytes) {
    validateLocation(block, slot);
    validateProgramCard(bytes);
    this.address = Uint8Array.of(block, slotBCD(slot));
    this.bytes = Uint8Array.from(bytes);
    this.phase = "initial";
    this.offset = 0;
    this.committed = false;
  }

  append(chunk) {
    // Each reply follows one request. Reject unsolicited/coalesced replies before
    // advancing to commit, matching the native, hardware-tested writer.
    if (chunk.length !== 1) throw new StorageError("Unexpected stored-slot write acknowledgement.");
    const byte = chunk[0];
    if (byte === 0xae) throw new StorageError("The calculator reported a storage-write error.");
    if (byte !== (this.phase === "selection" ? 0x55 : 0x04) || this.phase === "done") {
      throw new StorageError("Unexpected stored-slot write acknowledgement.");
    }
    let packet;
    switch (this.phase) {
      case "initial": this.phase = "selection"; packet = [0x55]; break;
      case "selection": this.phase = "chunk"; packet = this.address; break;
      case "chunk":
        if (this.offset < 150) {
          packet = [0x00, ...this.bytes.slice(this.offset, this.offset + 10)];
          this.offset += 10;
        } else {
          this.committed = true;
          this.phase = "commit";
          packet = [0xaa];
        }
        break;
      case "commit": this.phase = "completion"; packet = [0xff]; break;
      case "completion": this.phase = "done"; break;
    }
    return { packets: packet ? [Uint8Array.from(packet)] : [], complete: this.phase === "done" };
  }
}
