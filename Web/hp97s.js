// CalCom's PC test path, not the isolated external-equipment connector.
// Evidence: Research/TEENIX97-HP97S-Protocol.md and HP97S-firmware21-follow-up.md.
const alphabet = "0123456789.XEASN";
const names = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Decimal point", "Exponent", "Enter", "Run A", "Change sign", "End"];
const byteHex = value => value.toString(16).padStart(2, "0").toUpperCase();

export function encodeHP97SEntry(text) {
  let input = String(text).toUpperCase();
  if (input.endsWith("N")) input = input.slice(0, -1);
  if (!input.length) throw new Error("Enter at least one digit or key before sending.");
  if (input.length > 9) throw new Error("Use at most nine digits or keys. Teenio adds the tenth end symbol.");
  const codes = Array.from(input, symbol => {
    const code = alphabet.indexOf(symbol);
    if (code < 0 || code === 15) throw new Error("Use digits 0–9, . (decimal), X (exponent), E (Enter), A (Run A), or S (change sign). N is allowed only at the end.");
    return code;
  });
  if (codes.includes(13) && codes.indexOf(13) !== codes.length - 1) throw new Error("Run A must be the last key in the entry.");
  const runsProgram = codes.includes(13);
  return Object.freeze({ text: input, codes: Object.freeze([...codes, 15]), labels: Object.freeze([...codes.map(code => names[code]), runsProgram ? "End if requested" : "End"]), runsProgram });
}

export function decodeHP97SStatus(byte) {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255 || (byte & 0x60)) throw new Error(`Unexpected HP-97S status byte: ${byteHex(byte)}.`);
  return Object.freeze({ byte, ready: Boolean(byte & 0x10), changed: Boolean(byte & 0x80), flags: Object.freeze([0, 1, 2, 3].map(bit => Boolean(byte & (1 << bit)))) });
}

const isFlagEvent = byte => (byte & 0xE0) === 0x80;
const errorFor = (byte, mode, command) => new Error(mode === "entering" && byte === 0xF5
  ? "HP-97S entry returned F5 instead of the ON acknowledgement FF. The calculator may already be in its separate 97S mode. Leave 97S off in the calculator menu, restart and reconnect normally, then turn the interface on in Teenio. No keys were sent."
  : mode === "on" && command === 0xF0 && byte === 0xF5
    ? "HP-97S mode entry was acknowledged, but the status query returned F5 instead of flags. Firmware 21 may route HP-97S commands to the wired PC connection rather than Bluetooth. This does not confirm that the interface is off. No further commands were sent; disconnect and restart the calculator before reconnecting."
  : byte === 0xA1 ? "HP-97S reported a full digit buffer (A1)."
  : byte === 0xA2 ? "HP-97S reported a transfer error (A2); its precise cause is not verified."
  : `Unexpected HP-97S response ${byteHex(byte)}.`);

export class HP97SController {
  constructor({ write, onChange = () => {}, onLog = () => {}, timeoutMs = 3000, digitTimeoutMs = 1200 }) {
    Object.assign(this, { write, onChange, onLog, timeoutMs, digitTimeoutMs });
    this.mode = "off";
    this.busy = false;
    this.status = null;
    this.error = null;
    this.waiter = null;
    this.closed = false;
    this.lastAccepted = null;
  }

  get blocksNormalCommands() { return this.mode !== "off" || this.busy; }
  change() { this.onChange(this); }
  check() {
    if (this.closed) throw new Error("The HP-97S connection was closed.");
    if (this.mode === "fault") throw this.error;
  }
  fault(error) {
    if (this.closed || this.mode === "fault") return;
    this.error = error;
    this.mode = "fault";
    this.status = null;
    this.onLog(`${error.message} Stopped; no automatic retry. Calculator state is uncertain.`);
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.change();
  }

  receive(bytes) {
    if (this.closed || this.mode === "fault") return;
    for (const byte of bytes) {
      this.onLog(`RX ${byteHex(byte)}`);
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        clearTimeout(waiter.timer);
        if (!waiter.accept(byte)) {
          const error = isFlagEvent(byte) ? new Error("A flag notification arrived during the exchange. Transfer stopped because interleaving is not yet verified.") : errorFor(byte, this.mode, waiter.command);
          this.fault(error);
          waiter.reject(error);
          return;
        }
        waiter.resolve(byte);
      } else if (this.mode === "on" && !this.busy && isFlagEvent(byte)) {
        this.status = decodeHP97SStatus(byte);
        this.onLog(`Flags changed; calculator ${this.status.ready ? "ready" : "not ready"}.`);
        this.change();
      } else {
        this.fault(new Error(`Unsolicited HP-97S byte ${byteHex(byte)}. No further commands were sent.`));
        return;
      }
    }
  }

  async exchange(byte, accept, description, timeoutMs = this.timeoutMs) {
    this.check();
    const reply = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, accept, command: byte };
      waiter.timer = setTimeout(() => {
        if (this.waiter === waiter) this.fault(new Error(`Timed out waiting for ${description}.`));
      }, timeoutMs);
      this.waiter = waiter;
    });
    this.onLog(`TX ${byteHex(byte)} · ${description}`);
    // Install the waiter first: even a synchronous transport reply must be caught.
    try {
      Promise.resolve(this.write(Uint8Array.of(byte))).catch(error => this.fault(new Error(`HP-97S send failed: ${error.message}`)));
    } catch (error) { this.fault(new Error(`HP-97S send failed: ${error.message}`)); }
    const value = await reply;
    this.check();
    return value;
  }

  async operation(requiredMode, action) {
    this.check();
    if (this.busy) throw new Error("An HP-97S operation is already in progress.");
    if (this.mode !== requiredMode) throw new Error(requiredMode === "on" ? "Turn on the HP-97S interface first." : "The HP-97S interface is already on.");
    this.busy = true;
    this.change();
    try { return await action(); }
    finally { this.busy = false; this.change(); }
  }

  async enter() {
    return this.operation("off", async () => {
      this.mode = "entering";
      this.change();
      const byte = await this.exchange(0x12, value => value === 0xFF || value === 0, "mode entry acknowledgement");
      if (byte === 0) {
        this.mode = "off";
        throw new Error("The calculator rejected HP-97S mode. Set its switch to RUN and try again.");
      }
      this.mode = "on";
      this.status = null;
      this.onLog("HP-97S test mode is on. Read status before entering data.");
    });
  }

  async leave() {
    return this.operation("on", async () => {
      this.mode = "leaving";
      this.change();
      await this.exchange(0xF5, byte => byte === 0xF5, "mode exit acknowledgement");
      this.mode = "off";
      this.status = null;
      this.onLog("HP-97S test mode is off. Normal calculator commands are available.");
    });
  }

  async queryStatus() {
    const byte = await this.exchange(0xF0, value => !(value & 0x60), "calculator status");
    this.status = decodeHP97SStatus(byte);
    this.onLog(`Status ${byteHex(byte)} · ${this.status.ready ? "ready" : "not ready"}; flags 3–0: ${[...this.status.flags].reverse().map(flag => flag ? "1" : "0").join("")}.`);
    this.change();
    return this.status;
  }

  async readStatus() { return this.operation("on", () => this.queryStatus()); }

  async send(text) {
    const entry = encodeHP97SEntry(text); // Freeze the source before the first byte.
    return this.operation("on", async () => {
      this.lastAccepted = null;
      const status = await this.queryStatus();
      if (!status.ready) throw new Error("The calculator is not ready. No digits were sent. Check RUN mode, program activity and Flag 3.");
      this.status = null;
      this.change();
      await this.exchange(0xF1, byte => byte === 0xF1, "permission to send digits", this.digitTimeoutMs);
      for (const code of entry.codes) {
        // Firmware 21 completes at Run A. Only send NOP if another F1 requests it.
        const reply = await this.exchange(code,
          byte => code === 15 ? byte === 0xA0 : byte === 0xF1 || (code === 13 && byte === 0xA0),
          code === 15 ? "transfer acceptance" : code === 13 ? "Run A acceptance or next-key prompt" : `next-key prompt after ${names[code]}`,
          this.digitTimeoutMs);
        if (reply === 0xA0) break;
      }
      this.lastAccepted = entry;
      this.onLog("Transfer accepted (A0). This acknowledges key entry; it does not verify the displayed value or a program result.");
      return entry;
    });
  }

  close() {
    const uncertain = this.blocksNormalCommands;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error("Connection lost during the HP-97S exchange. Completion is uncertain; no retry was made.")); }
    this.mode = "off";
    this.status = null;
    return uncertain;
  }
}

// A protocol peer for Demo mode, intentionally not an HP calculator emulator.
export class DemoHP97SDevice {
  constructor() { this.active = false; this.collecting = false; this.status = 0x10; this.keys = []; this.lastKeys = []; }
  write(bytes) {
    if (bytes.length !== 1) throw new Error("Expected one HP-97S byte.");
    const [byte] = bytes;
    if (!this.active) {
      if (byte !== 0x12) throw new Error("Demo HP-97S mode is off.");
      this.active = true;
      return [0xFF];
    }
    if (this.collecting) {
      if (byte !== 15) {
        if (byte > 14 || this.keys.length >= 9) { this.collecting = false; return [0xA1]; }
        this.keys.push(byte);
      }
      if (byte === 15 || byte === 13) {
        this.lastKeys = [...this.keys];
        this.collecting = false;
        this.status = (this.status & 7) | (this.keys.includes(13) ? 0x10 : 8);
        return [0xA0];
      }
      return [0xF1];
    }
    if (byte === 0xF5) { this.active = false; return [0xF5]; }
    if (byte === 0xF0) return [this.status];
    if (byte === 0xF1) {
      if (!(this.status & 0x10)) return [this.status];
      this.collecting = true;
      this.keys = [];
      return [0xF1];
    }
    throw new Error("Unexpected Demo HP-97S command.");
  }
  toggleFlag(bit) {
    this.status ^= 1 << bit;
    this.status = (this.status & 8) ? (this.status & ~0x10) : (this.status | 0x10);
    return [this.status | 0x80];
  }
}
