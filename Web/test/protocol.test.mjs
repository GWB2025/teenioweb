import test from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_INFORMATION_REPLY,
  InformationDecoder,
  ProtocolError,
  decodeInformation,
  settingsReport,
} from "../protocol.js";

test("captured firmware 21 reply decodes every known setting", () => {
  const info = decodeInformation(DEMO_INFORMATION_REPLY);
  assert.equal(info.model, "HP-97");
  assert.equal(info.firmware, "21");
  assert.deepEqual(Object.fromEntries(info.settings), {
    "Continuous memory": "On",
    "Turbo mode": "On",
    "Beeper": "Off",
    "Show model at power on": "Yes",
    "Alternate functions": "Disabled",
    "Program as text": "Off",
    "Card write protection": "Normal",
    "Key debounce": "Short",
    "Internal printer": "Off",
    "Printer output": "Normal",
    "Speed": "0 (default)",
    "Display intensity": "0 (default)",
  });
});

test("information decoder accepts every fragment boundary", () => {
  for (let boundary = 0; boundary <= 8; boundary += 1) {
    const decoder = new InformationDecoder();
    const first = decoder.append(DEMO_INFORMATION_REPLY.slice(0, boundary));
    if (boundary === 8) assert.equal(first.firmware, "21");
    else {
      assert.equal(first, null);
      assert.equal(decoder.append(DEMO_INFORMATION_REPLY.slice(boundary)).firmware, "21");
    }
  }
});

test("information decoder accepts byte-by-byte input", () => {
  const decoder = new InformationDecoder();
  let result = null;
  for (const byte of DEMO_INFORMATION_REPLY) result = decoder.append(Uint8Array.of(byte));
  assert.equal(result.firmware, "21");
});

test("invalid mode, model, version and excess bytes are rejected", () => {
  assert.throws(() => decodeInformation(Uint8Array.of(0x07, 0x61, 0, 0, 0x21, 0, 0, 0)), ProtocolError);
  assert.throws(() => decodeInformation(Uint8Array.of(0x55, 0x67, 0, 0, 0x21, 0, 0, 0)), ProtocolError);
  assert.throws(() => decodeInformation(Uint8Array.of(0x55, 0x61, 0, 0, 0xfa, 0, 0, 0)), ProtocolError);
  const decoder = new InformationDecoder();
  assert.throws(() => decoder.append(Uint8Array.of(...DEMO_INFORMATION_REPLY, 0)), ProtocolError);
});

test("settings report labels Demo data and physical data distinctly", () => {
  const info = decodeInformation(DEMO_INFORMATION_REPLY);
  const common = { ...info, capturedAt: new Date("2026-09-22T14:03:03Z") };
  const demo = settingsReport({ ...common, simulated: true });
  const live = settingsReport({ ...common, simulated: false });
  assert.match(demo, /DEMO EXAMPLE/);
  assert.match(live, /Bluetooth calculator read/);
  assert.match(live, /Information reply: 55 61 DD 91 21 05 11 00/);
});
