export const INFORMATION_QUERY = Uint8Array.of(0x07);
export const DEMO_INFORMATION_REPLY = Uint8Array.of(0x55, 0x61, 0xdd, 0x91, 0x21, 0x05, 0x11, 0x00);

export function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export class ProtocolError extends Error {}

export class InformationDecoder {
  constructor() {
    this.bytes = [];
  }

  append(chunk) {
    this.bytes.push(...chunk);
    if (this.bytes.length > 8) throw new ProtocolError("The calculator returned an unexpected reply length.");
    if (this.bytes.length >= 1 && this.bytes[0] !== 0x55) {
      throw new ProtocolError("The calculator did not return a normal operating-mode reply.");
    }
    if (this.bytes.length >= 2 && this.bytes[1] !== 0x61) {
      throw new ProtocolError("The reply does not identify an HP-97.");
    }
    if (this.bytes.length < 8) return null;
    return decodeInformation(Uint8Array.from(this.bytes));
  }
}

function offsetLabel(offset, raw) {
  if (offset === null) return `Unrecognised (raw ${raw.toString(16).padStart(2, "0").toUpperCase()})`;
  if (offset === 0) return "0 (default)";
  return offset > 0 ? `+${offset}` : String(offset);
}

export function decodeInformation(reply) {
  if (reply.length !== 8) throw new ProtocolError("The calculator returned an unexpected reply length.");
  if (reply[0] !== 0x55) throw new ProtocolError("The calculator did not return a normal operating-mode reply.");
  if (reply[1] !== 0x61) throw new ProtocolError("The reply does not identify an HP-97.");

  const tens = reply[4] >> 4;
  const units = reply[4] & 0x0f;
  if (tens > 9 || units > 9) throw new ProtocolError("The reply contains an invalid firmware-version field.");

  const flags = reply[2];
  const flag = (mask, set, clear) => (flags & mask) !== 0 ? set : clear;
  const speedRaw = reply[6];
  const speedOffset = speedRaw >= 10 && speedRaw <= 24 ? speedRaw - 17 : null;
  const intensityRaw = reply[7];
  const intensityPosition = (intensityRaw + 16) & 0xff;
  const intensityOffset = intensityPosition <= 32 ? intensityPosition - 16 : null;

  return {
    model: "HP-97",
    firmware: `${tens}${units}`,
    response: Uint8Array.from(reply),
    settings: [
      ["Continuous memory", flag(0x80, "On", "Off")],
      ["Turbo mode", flag(0x20, "Off", "On")],
      ["Beeper", flag(0x10, "Off", "On")],
      ["Show model at power on", flag(0x02, "No", "Yes")],
      ["Alternate functions", flag(0x04, "Disabled", "Enabled")],
      ["Program as text", flag(0x40, "Off", "On")],
      ["Card write protection", flag(0x01, "Normal", "Override")],
      ["Key debounce", flag(0x08, "Short", "Long")],
      ["Internal printer", (reply[3] & 0x04) !== 0 ? "On" : "Off"],
      ["Printer output", (reply[5] & 0x04) !== 0 ? "Normal" : "IR"],
      ["Speed", offsetLabel(speedOffset, speedRaw)],
      ["Display intensity", offsetLabel(intensityOffset, intensityRaw)],
    ],
  };
}

export function settingsReport(reading) {
  const lines = [
    "Teenio Web · HP-97 settings",
    reading.simulated ? "Source: DEMO EXAMPLE — not read from a calculator" : "Source: Bluetooth calculator read",
    `Read at: ${reading.capturedAt.toISOString()}`,
    `Model: ${reading.model}`,
    `Firmware: ${reading.firmware}`,
    "",
    ...reading.settings.map(([name, value]) => `${name}: ${value}`),
  ];
  if (reading.response) lines.push("", `Information reply: ${hex(reading.response)}`);
  lines.push("", "Speed and intensity are offsets from the default setting; these are not percentages.");
  lines.push("This report does not back up program memory.");
  return `${lines.join("\n")}\n`;
}
