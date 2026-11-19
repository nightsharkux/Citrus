# Hardware clients

| File | Use |
|---|---|
| `simulator.js` | Acts as a puck, reader or door light from your terminal, so you can test the whole flow without hardware. `node hardware/simulator.js --url http://localhost:3100 --id dev_1 --secret …` |
| `citrus_device.py` | A reference client for a Raspberry Pi or PC. Standard library only, plus optional `pyscard` for PC/SC NFC readers. Replace the `on_*` hooks with your LED, speaker or display code. |

Register a device first (Admin → Devices) to get its ID and secret. The protocol, events, commands and activation flow are documented in [../docs/HARDWARE.md](../docs/HARDWARE.md).

A card tap never signs anyone in by itself. The lecturer always confirms in the app.
