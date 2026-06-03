// Loopback test: writes a unique string and checks whether it comes back.
// Short DB9 pins 2 (RXD) and 3 (TXD) together at the adapter, with NOTHING
// else connected, then run this. If the string echoes back, the adapter +
// driver + software all work and the fault is the cable/amp. If nothing
// comes back, the adapter/driver isn't moving data.
const { SerialPort } = require("serialport");

const DEVICE = process.env.DEVICE || "/dev/cu.usbserial-210";
const BAUD = parseInt(process.env.BAUD || "9600", 10);
const TOKEN = "LOOPBACK_" + Date.now() + "\r";

const port = new SerialPort(
  { path: DEVICE, baudRate: BAUD, dataBits: 8, parity: "none", stopBits: 1, rtscts: false },
  (err) => {
    if (err) {
      console.error("OPEN ERROR:", err.message);
      process.exit(1);
    }
  }
);

let got = Buffer.alloc(0);
port.on("data", (d) => (got = Buffer.concat([got, d])));
port.on("open", () => {
  port.set({ dtr: true, rts: true }, () => {});
  console.log(`Open ${DEVICE} @ ${BAUD}. Writing token: ${JSON.stringify(TOKEN)}`);
  port.write(Buffer.from(TOKEN, "latin1"));
  port.drain();
  setTimeout(() => {
    const text = got.toString("latin1").replace(/\r/g, "<CR>");
    console.log(`\nBytes received: ${got.length}`);
    console.log(`Received text : ${text || "(nothing)"}`);
    if (got.toString("latin1").includes(TOKEN.replace("\r", ""))) {
      console.log("\nRESULT: ✓ LOOPBACK OK — adapter, driver, and software all work.");
      console.log("        => The fault is the cable to the amp (likely wrong type) or the amp's serial port.");
    } else if (got.length > 0) {
      console.log("\nRESULT: ~ Partial/garbled echo — likely a baud or signal-integrity issue.");
    } else {
      console.log("\nRESULT: ✗ NO ECHO — the adapter/driver is not moving data (replace the PL2303 adapter, ideally with an FTDI one).");
    }
    port.close(() => process.exit(0));
  }, 1200);
});
