"""Citrus reference device client (protocol v1).

Runs on a Raspberry Pi or any Linux/Windows box. Standard library only;
card reading uses the optional `pyscard` package with any PC/SC NFC reader.

    python3 hardware/campusos_device.py --url https://campus.example.edu \
        --id dev_3 --secret <secret> [--nfc]

What it does
  * Long-polls /api/v1/device/heartbeat and handles commands
    (room.status -> set a light colour, speak -> text-to-speech, ...).
  * With --nfc: reads card UIDs and sends `nfc.tap` events. A tap never signs
    anyone in by itself; the lecturer confirms in the Citrus app.

Replace the `on_*` functions with real GPIO / LED / speaker code.
See docs/HARDWARE.md for the full protocol.
"""
import argparse
import hashlib
import hmac
import json
import secrets
import threading
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------- protocol

def sign(secret, method, path, timestamp, nonce, body):
    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    canonical = "\n".join([method.upper(), path, str(timestamp), nonce, body_hash])
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


class CampusDevice:
    def __init__(self, url, device_id, secret):
        self.url = url.rstrip("/")
        self.device_id = device_id
        self.secret = secret

    def call(self, path, payload=None, timeout=35):
        full_path = "/api/v1/device/" + path
        body = json.dumps(payload or {})
        timestamp = int(time.time() * 1000)
        nonce = secrets.token_hex(16)
        headers = {
            "Content-Type": "application/json",
            "X-Device-Id": self.device_id,
            "X-Device-Timestamp": str(timestamp),
            "X-Device-Nonce": nonce,
            "X-Device-Signature": sign(self.secret, "POST", full_path, timestamp, nonce, body),
        }
        request = urllib.request.Request(self.url + full_path, data=body.encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {error.code}: {detail}") from None

    def heartbeat(self, wait=25):
        return self.call("heartbeat", {"firmware": "campusos-py-1.0", "capabilities": CAPABILITIES, "wait": wait})

    def event(self, kind, data):
        return self.call("events", {"type": kind, "data": data}, timeout=90)

    def ack(self, command_id, result="ok"):
        return self.call(f"commands/{command_id}/ack", {"result": result})


# --------------------------------------------------------------------------- hardware hooks

CAPABILITIES = ["light", "speaker"]
COLOURS = {"open": "green", "quiet": "amber", "do_not_disturb": "red", "consultation": "blue"}


def on_room_status(payload):
    colour = COLOURS.get(payload.get("status"), "off")
    print(f"[light] {colour.upper()}  {payload.get('note') or ''}")
    # e.g. set_led(colour)


PULSE = {"good": "green", "watch": "amber", "trouble": "red", "quiet": "white", "off": "off"}


def on_class_pulse(payload):
    # The live class status during a lecture: red means many students are lost, so explain again.
    colour = PULSE.get(payload.get("status"), "off")
    print(f"[puck] {colour.upper()}  {payload.get('following', 0)} following, {payload.get('unsure', 0)} unsure, {payload.get('lost', 0)} lost")
    # e.g. set_ring(colour)


def on_speak(payload):
    print(f"[speaker] {payload.get('text')}")
    # e.g. subprocess.run(["espeak-ng", payload["text"]])


def on_message(payload):
    print(f"[display] {payload.get('text')}")


HANDLERS = {
    "room.status": on_room_status,
    "class.pulse": on_class_pulse,
    "speak": on_speak,
    "display.message": on_message,
    "session.started": lambda p: on_message({"text": f"Session started by {p.get('lecturer')}"}),
    "session.ended": lambda p: on_message({"text": "Session ended"}),
    "nfc.pair": lambda p: on_message({"text": f"Tap card to link: {p.get('name')}"}),
    "ping": lambda p: None,
}


# --------------------------------------------------------------------------- loops

def command_loop(device):
    first = True
    while True:
        try:
            beat = device.heartbeat(wait=0 if first else 25)
            if first:
                info = beat["device"]
                print(f"Connected as {info['name']} ({info['kind']}) in room {info['room'] or '-'}")
                if beat.get("room"):
                    on_room_status(beat["room"])
                first = False
            for command in beat.get("commands", []):
                handler = HANDLERS.get(command["type"])
                try:
                    if handler:
                        handler(command.get("payload", {}))
                    device.ack(command["id"], "ok" if handler else "unsupported")
                except Exception as error:  # keep the loop alive whatever the hardware does
                    device.ack(command["id"], f"error: {error}")
        except Exception as error:
            print(f"Heartbeat failed: {error}; retrying in 5 s")
            time.sleep(5)


def nfc_loop(device):
    """Poll a PC/SC reader and send each new card UID once."""
    try:
        from smartcard.System import readers
    except ImportError:
        print("Install pyscard for NFC support: python -m pip install pyscard")
        return
    last_uid, last_time = None, 0.0
    while True:
        try:
            available = readers()
            if not available:
                time.sleep(2)
                continue
            connection = available[0].createConnection()
            connection.connect()
            data, sw1, sw2 = connection.transmit([0xFF, 0xCA, 0x00, 0x00, 0x00])  # GET UID
            if (sw1, sw2) == (0x90, 0x00) and data:
                uid = "".join(f"{b:02X}" for b in data)
                if uid != last_uid or time.time() - last_time > 5:
                    last_uid, last_time = uid, time.time()
                    result = device.event("nfc.tap", {"uid": uid})
                    on_message({"text": {
                        "activation_pending": f"Hi {result.get('name')} - confirm in the app",
                        "checked_in": f"Checked in: {result.get('name')}",
                        "paired": f"Card linked: {result.get('name')}",
                        "unknown_card": "Card not recognised",
                        "no_open_session": "No open check-in in this room",
                    }.get(result.get("result"), result.get("result"))})
        except Exception:
            pass  # no card on the reader
        time.sleep(0.4)


def main():
    parser = argparse.ArgumentParser(description="Citrus device client")
    parser.add_argument("--url", required=True)
    parser.add_argument("--id", required=True, help="Device ID, e.g. dev_3")
    parser.add_argument("--secret", required=True)
    parser.add_argument("--nfc", action="store_true", help="read cards from a PC/SC reader")
    args = parser.parse_args()

    device = CampusDevice(args.url, args.id, args.secret)
    if args.nfc:
        CAPABILITIES.append("nfc")
        threading.Thread(target=nfc_loop, args=(device,), daemon=True).start()
    command_loop(device)


if __name__ == "__main__":
    main()
