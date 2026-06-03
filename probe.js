// Serial probe for the Monoprice MPR-6ZHMAUT.
// Lists ports, then sweeps baud rates sending a status query at each,
// reporting any bytes received. Uses the real serialport library so it
// exercises the exact path the server will use (incl. DTR/RTS on open).
const { SerialPort } = require("serialport");

const DEVICE = process.env.DEVICE || "/dev/cu.usbserial-210";
const BAUDS = process.env.BAUD
  ? [parseInt(process.env.BAUD, 10)]
  : [9600, 19200, 38400, 57600, 115200, 230400];
const QUERIES = ["?10\r", "?11\r"];
const WAIT_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dump(buf) {
  const ascii = buf
    .toString("latin1")
    .replace(/\r/g, "<CR>")
    .replace(/\n/g, "<LF>");
  const hex = buf.toString("hex").match(/../g)?.join(" ") || "";
  return { ascii, hex };
}

async function tryBaud(baudRate) {
  return new Promise((resolve) => {
    const chunks = [];
    let port;
    try {
      port = new SerialPort({
        path: DEVICE,
        baudRate,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        rtscts: false,
        autoOpen: false,
      });
    } catch (e) {
      return resolve({ baudRate, error: e.message, bytes: 0 });
    }

    port.on("data", (d) => chunks.push(d));
    port.on("error", (e) => {
      // surface but don't crash the sweep
      console.error(`  [error @ ${baudRate}] ${e.message}`);
    });

    port.open(async (err) => {
      if (err) return resolve({ baudRate, error: err.message, bytes: 0 });
      // Toggle DTR/RTS true explicitly (some adapters gate the line driver on these)
      port.set({ dtr: true, rts: true }, () => {});
      for (const q of QUERIES) {
        port.write(Buffer.from(q, "latin1"));
        port.drain(() => {});
        await sleep(WAIT_MS / QUERIES.length);
      }
      const buf = Buffer.concat(chunks);
      port.close(() =>
        resolve({ baudRate, bytes: buf.length, ...dump(buf) })
      );
    });
  });
}

(async () => {
  console.log("=== Available serial ports ===");
  try {
    const ports = await SerialPort.list();
    for (const p of ports) {
      console.log(
        `  ${p.path}  vid=${p.vendorId || "?"} pid=${p.productId || "?"} mfg=${p.manufacturer || "?"}`
      );
    }
  } catch (e) {
    console.log("  (list failed: " + e.message + ")");
  }

  console.log(`\n=== Probing ${DEVICE} ===`);
  for (const b of BAUDS) {
    const r = await tryBaud(b);
    if (r.error) {
      console.log(`baud ${b}: OPEN ERROR -> ${r.error}`);
    } else if (r.bytes > 0) {
      console.log(`baud ${b}: ${r.bytes} bytes  ✓`);
      console.log(`   ascii: ${r.ascii}`);
      console.log(`   hex  : ${r.hex}`);
    } else {
      console.log(`baud ${b}: 0 bytes`);
    }
  }
  console.log("\nProbe done.");
  process.exit(0);
})();
