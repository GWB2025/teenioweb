import { PROGRAM_KEY_CODES, PROGRAM_NAMES } from "./program-table.js";

export class TransferError extends Error {}

function bcd(byte, maximum) {
  const tens = byte >> 4;
  const units = byte & 0x0f;
  const value = tens * 10 + units;
  if (tens > 9 || units > 9 || value > maximum) throw new TransferError("The calculator clock returned an invalid date or time.");
  return value;
}

function toBCD(value) {
  return ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
}

export function decodeClock(raw) {
  if (raw.length !== 16) throw new TransferError("The calculator clock response was incomplete or unexpected.");
  const second = bcd(raw[0] & 0x7f, 59);
  const minute = bcd(raw[1] & 0x7f, 59);
  const hour = bcd(raw[2] & 0x3f, 23);
  const day = Math.max(1, bcd(raw[4] & 0x3f, 31));
  const month = Math.max(1, bcd(raw[5] & 0x1f, 12));
  const year = bcd(raw[6], 99) + 2000;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
      date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
    throw new TransferError("The calculator clock returned an invalid date or time.");
  }
  return { date, raw: Uint8Array.from(raw) };
}

export function clockSettingPackets(date) {
  const year = date.getFullYear();
  if (Number.isNaN(date.getTime()) || year < 2000 || year > 2099) {
    throw new TransferError("Choose a valid date and time between 2000 and 2099.");
  }
  return [
    Uint8Array.of(0x00, 0x00, 0x03, toBCD(date.getSeconds()), toBCD(date.getMinutes()), toBCD(date.getHours())),
    Uint8Array.of(0x00, 0x03, 0x04, date.getDay() + 1, toBCD(date.getDate()), toBCD(date.getMonth() + 1), toBCD(year % 100)),
  ];
}

export class ClockReadTransfer {
  constructor() {
    this.phase = "command";
    this.bytes = [];
  }

  append(chunk) {
    const packets = [];
    let complete = false;
    for (const byte of chunk) {
      if (byte === 0xae && (this.phase === "command" || this.phase === "mode")) {
        throw new TransferError("The calculator reported that its clock is unavailable.");
      }
      switch (this.phase) {
        case "command":
          if (byte !== 0x0f) throw new TransferError("The calculator clock response was incomplete or unexpected.");
          this.phase = "mode";
          packets.push(Uint8Array.of(0x01));
          break;
        case "mode":
          if (byte !== 0x01) throw new TransferError("The calculator clock response was incomplete or unexpected.");
          this.phase = "first";
          packets.push(Uint8Array.of(0x01));
          break;
        case "first":
        case "second":
          this.bytes.push(byte);
          if (this.bytes.length === 8) {
            this.phase = "second";
            packets.push(Uint8Array.of(0x01));
          } else if (this.bytes.length === 16) {
            this.phase = "finish";
            packets.push(Uint8Array.of(0x00));
          } else if (this.bytes.length > 16) {
            throw new TransferError("The calculator clock response was incomplete or unexpected.");
          }
          break;
        case "finish":
          if (byte !== 0x00) throw new TransferError("The calculator clock response was incomplete or unexpected.");
          this.phase = "done";
          complete = true;
          break;
        default:
          throw new TransferError("The calculator clock sent data after completing the transfer.");
      }
    }
    return { packets, complete, result: complete ? decodeClock(this.bytes) : null };
  }
}

export class ClockWriteTransfer {
  constructor(date) {
    this.phase = "command";
    this.packets = clockSettingPackets(date);
  }

  append(chunk) {
    if (chunk.length !== 1) throw new TransferError("The calculator clock response was incomplete or unexpected.");
    const byte = chunk[0];
    if (byte === 0xae) throw new TransferError("The calculator reported that its clock is unavailable.");
    switch (this.phase) {
      case "command":
        if (byte !== 0x0f) break;
        this.phase = "mode";
        return { packets: [Uint8Array.of(0x00)], complete: false };
      case "mode":
        if (byte !== 0x00) break;
        this.phase = "time";
        return { packets: [this.packets[0]], complete: false };
      case "time":
        if (byte !== 0x00) break;
        this.phase = "date";
        return { packets: [this.packets[1]], complete: false };
      case "date":
        if (byte !== 0x00) break;
        this.phase = "finish";
        return { packets: [Uint8Array.of(0x01)], complete: false };
      case "finish":
        if (byte !== 0x01) break;
        this.phase = "done";
        return { packets: [], complete: true };
      default:
        throw new TransferError("The calculator clock sent data after completing the transfer.");
    }
    throw new TransferError("The calculator clock response was incomplete or unexpected.");
  }
}

export class RAMReadTransfer {
  constructor() {
    this.phase = "echo";
    this.bytes = [];
    this.frame = [];
  }

  append(chunk) {
    const packets = [];
    let complete = false;
    for (const byte of chunk) {
      switch (this.phase) {
        case "echo":
          if (byte !== 0x0c) throw new TransferError("The memory reply did not match the expected transfer.");
          this.phase = "register";
          packets.push(Uint8Array.of(0xaa));
          break;
        case "register":
          this.frame.push(byte);
          if (this.frame.length === 8) {
            if (this.frame[0] !== 0xaa) throw new TransferError("The memory reply did not match the expected transfer.");
            this.bytes.push(...this.frame.slice(1));
            this.frame = [];
            if (this.bytes.length === 448) {
              this.phase = "completion";
              packets.push(Uint8Array.of(0x55));
            } else if (this.bytes.length < 448) {
              packets.push(Uint8Array.of(0xaa));
            } else {
              throw new TransferError("The memory reply exceeded 448 bytes.");
            }
          }
          break;
        case "completion":
          if (byte !== 0x0c) throw new TransferError("The memory completion reply was unexpected.");
          this.phase = "done";
          complete = true;
          break;
        default:
          throw new TransferError("The calculator sent data after completing the memory transfer.");
      }
    }
    return { packets, complete, result: complete ? decodeRAM(Uint8Array.from(this.bytes)) : null };
  }
}

export function registerNumber(raw) {
  if (raw.length !== 7) return "Unavailable";
  const nibbles = Array.from(raw).flatMap(byte => [byte >> 4, byte & 0x0f]);
  if (nibbles.some(value => value > 9) || ![0, 9].includes(nibbles[13]) || ![0, 9].includes(nibbles[2])) {
    return "Non-numeric · see bytes";
  }
  const digits = Array.from({ length: 10 }, (_, offset) => nibbles[12 - offset]).join("");
  if (/^0+$/.test(digits)) return "0";
  const exponent = (nibbles[2] === 9 ? -1 : 1) * (nibbles[1] * 10 + nibbles[0]);
  const mantissa = `${digits[0]}.${digits.slice(1)}`;
  return `${nibbles[13] === 9 ? "−" : ""}${mantissa} × 10^${exponent}`;
}

function byteHex(byte) {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}

export function decodeRAM(bytes) {
  if (bytes.length !== 448) throw new TransferError("A complete HP-97 memory capture must contain 448 bytes.");
  const registerNames = [...Array.from({ length: 10 }, (_, index) => String(index)), "A", "B", "C", "D", "E", "I"];
  const registers = registerNames.map((name, index) => {
    const raw = bytes.slice(index * 7, index * 7 + 7);
    return { name, value: registerNumber(raw), hex: Array.from(raw, byteHex).join(" ") };
  });
  const rows = Array.from({ length: 64 }, (_, address) => {
    const raw = bytes.slice(address * 7, address * 7 + 7);
    return `${byteHex(address)}  ${Array.from(raw, byteHex).join(" ")}`;
  });
  const program = Array.from({ length: 224 }, (_, index) => {
    const address = 0x2f - Math.floor(index / 7);
    const offset = index % 7;
    const packed = bytes[address * 7 + offset];
    const opcode = ((packed << 4) | (packed >> 4)) & 0xff;
    return {
      number: index + 1,
      opcode,
      instruction: PROGRAM_NAMES[opcode],
      keyCodes: PROGRAM_KEY_CODES[opcode],
      ramAddress: address,
      byteOffset: offset,
    };
  });
  return { capturedAt: new Date(), bytes: Uint8Array.from(bytes), registers, rows, program, simulated: false };
}

export function demoRAM() {
  const bytes = new Uint8Array(448);
  for (let index = 0; index < 16; index += 1) bytes[index * 7 + 6] = ((index % 9) + 1) << 4;
  bytes[0x2f * 7] = 0x1f;
  bytes[0x2f * 7 + 1] = 0x11;
  bytes[0x2f * 7 + 2] = 0xe0;
  bytes[0x1f * 7] = 0x2f;
  const reading = decodeRAM(bytes);
  reading.simulated = true;
  return reading;
}

export function memoryReport(reading) {
  return [
    "HP-97 active RAM capture",
    `Source: ${reading.simulated ? "DEMO EXAMPLE" : "Bluetooth calculator read"}`,
    `Captured: ${reading.capturedAt.toISOString()}`,
    "448 bytes · 64 internal registers",
    "",
    "Primary storage registers",
    ...reading.registers.map(register => `${register.name}: ${register.value} [${register.hex}]`),
    "",
    "Internal RAM (hex addresses; program area 10–2F, see separate program listing)",
    ...reading.rows,
    "",
  ].join("\n");
}

export function programReport(reading) {
  const lines = reading.program.map(step => {
    const number = String(step.number).padStart(3, "0");
    const opcode = byteHex(step.opcode);
    return `${number}  ${opcode}  ${step.instruction.padEnd(11, " ")}  [${step.keyCodes}]`;
  });
  return [
    `Source: ${reading.simulated ? "DEMO EXAMPLE" : "Calculator RAM capture"}`,
    `Captured: ${reading.capturedAt.toISOString()}`,
    "HP-97 program listing",
    "224 memory positions · zeros are retained as R/S",
    "No.  Op  Instruction  [calculator key codes]",
    "",
    ...lines,
    "",
  ].join("\n");
}
