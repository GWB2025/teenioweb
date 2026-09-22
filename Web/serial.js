const SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb";

export class WebSerialTransport {
  constructor({ onBytes, onDisconnect, onLog }) {
    this.onBytes = onBytes;
    this.onDisconnect = onDisconnect;
    this.onLog = onLog;
    this.port = null;
    this.reader = null;
    this.closing = false;
    this.writeChain = Promise.resolve();
  }

  static supported() {
    return "serial" in navigator;
  }

  async connect() {
    if (!WebSerialTransport.supported()) {
      throw new Error("This browser does not provide Web Serial. Use Chrome 117 or later on a desktop computer.");
    }
    this.closing = false;
    this.port = await navigator.serial.requestPort({
      filters: [{ bluetoothServiceClassId: SPP_UUID }],
      allowedBluetoothServiceClassIds: [SPP_UUID],
    });
    await this.port.open({
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 255,
    });
    const details = this.port.getInfo();
    this.onLog(`Serial connection opened${details.bluetoothServiceClassId ? ` · RFCOMM ${details.bluetoothServiceClassId}` : ""}.`);
    void this.readLoop();
  }

  async readLoop() {
    try {
      while (this.port?.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          while (!this.closing) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onBytes(value);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      if (!this.closing) this.onLog(`Serial read failed: ${error.message}`);
    } finally {
      if (!this.closing) this.onDisconnect();
    }
  }

  write(bytes) {
    if (!this.port?.writable) return Promise.reject(new Error("The serial connection is not open."));
    const payload = Uint8Array.from(bytes);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const writer = this.port.writable.getWriter();
      try {
        await writer.write(payload);
      } finally {
        writer.releaseLock();
      }
    });
    return this.writeChain;
  }

  async disconnect() {
    this.closing = true;
    if (this.reader) await this.reader.cancel();
    await this.writeChain.catch(() => {});
    if (this.port) await this.port.close();
    this.port = null;
  }
}
