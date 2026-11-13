# Classroom hardware

Campus OS has a signed **device API** for classroom hardware: voice pucks, NFC card readers, door lights and displays. The server side is complete and tested. You bring the hardware.

**Safety principles**

- A card UID is not identity. A tap only *proposes* a sign-in, and the lecturer confirms it in the app.
- Only a keyed HMAC digest of a UID is stored. Raw UIDs are never saved and never sent to an AI model.
- Each device has its own secret (encrypted at rest). An admin can revoke it at any time, and the device is locked out at once.
- Proximity, taps and codes are participation records. They are not proof of attendance.

## Quick start without hardware

1. Admin → **Devices** → *Register device* (for example a voice puck in room `MF2`). Copy the ID and secret.
2. Run the simulator:
   ```cmd
   node hardware/simulator.js --url http://localhost:3100 --id dev_1 --secret <secret>
   ```
3. In the app, set room MF2 to *Do not disturb*. The simulator prints `Door light → DO NOT DISTURB`.
4. Lecturer → **Classroom** or a check-in session → *Link a card* (pick the reader). In the simulator, type `tap 04A1B2C3D4`.
5. Type `tap 04A1B2C3D4` again. The lecturer's app pops up *Start session in MF2?*. Confirm it, and a check-in with a live code opens and the room turns *quiet*.
6. `ask What is a hash map?` → the puck gets a spoken answer (if AI is configured). `end` closes the session.

## Real device (Raspberry Pi or similar)

```bash
python3 hardware/campusos_device.py --url https://campus.example.edu --id dev_3 --secret <secret> --nfc
```

The script uses the standard library only. Card reading uses `pyscard` with any PC/SC reader, for example an ACR122U. Replace the `on_room_status`, `on_speak` and `on_message` hooks with your GPIO, LED and speaker code.

## Protocol v1

Base path: `/api/v1/device/`. Every request is `POST` with a JSON body and these four headers:

| Header | Value |
|---|---|
| `X-Device-Id` | `dev_<n>` as shown at registration |
| `X-Device-Timestamp` | Unix time in **milliseconds**. Rejected if more than 120 s off server time |
| `X-Device-Nonce` | Random string of 16–64 characters, **never reused** (replays get 401) |
| `X-Device-Signature` | `hex(HMAC-SHA256(secret, canonical))` |

```text
canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(body))
```

`PATH` is the exact request path without the query string, e.g. `/api/v1/device/heartbeat`. Reference implementations: `src/modules/devices/protocol.js` (Node) and `sign()` in `hardware/campusos_device.py`.

### `POST heartbeat`

```json
{ "firmware": "puck-1.2", "capabilities": ["nfc", "speaker", "light"], "wait": 25 }
```

`wait` (0–25 s) long-polls: the response comes back as soon as a command is queued. The response:

```json
{ "serverTime": "…", "device": { "id": "dev_1", "name": "MF2 puck", "kind": "puck", "room": "MF2" },
  "room": { "room": "MF2", "status": "quiet", "note": "…" }, "activeSession": true,
  "commands": [ { "id": 41, "type": "room.status", "payload": { "status": "quiet", "note": "…" } } ] }
```

Devices go *offline* in the admin view after 90 s without a heartbeat.

### Commands (server → device)

| Type | Payload | Typical device |
|---|---|---|
| `room.status` | `{ room, status, note }`, where status is `open` · `quiet` · `do_not_disturb` · `consultation` | door light, display |
| `display.message` | `{ text }` | any device with a screen or LED |
| `class.pulse` | `{ session, status, following, unsure, lost, answered }`, where status is `good` (green) · `watch` (amber) · `trouble` (red: explain again) · `quiet` (too few answers) · `off` (lecture over). Sent to devices in the lecture's room when the status changes. Counts only, never names. | puck, door light, display |
| `speak` | `{ text }` (under 60 words, no markdown) | puck |
| `session.started` | `{ lecturer, course, sessionId }` | puck, display |
| `session.ended` | `{}` | puck, display |
| `nfc.pair` | `{ name }`: the next tap links that person's card | reader, puck |
| `ping` | `{}` | any |

Acknowledge each command: `POST commands/<id>/ack` with `{ "result": "ok" }`.

### Events (device → server): `POST events`

```json
{ "type": "nfc.tap", "data": { "uid": "04A1B2C3D4" } }
```

| Type | Data | Response `result` |
|---|---|---|
| `nfc.tap` | `{ uid }` (hex, 6–32 characters) | `paired` · `activation_pending` (lecturer: confirm in the app) · `checked_in` (student, if an open session exists in this room) · `no_open_session` · `unknown_card` · `pair_conflict` |
| `voice.query` | `{ text }` (speech-to-text happens on the device) | `answer` with `text` (also queued as `speak`) · `inactive` (no confirmed session) · `unavailable` (AI off) |
| `button.press` | `{ button }`. `end` closes the active session | `session_ended` · `ok` |
| `status` | anything small (temperature, uptime) | `ok` (logged) |

## Activation flow

```text
Lecturer taps card ─► device: nfc.tap ─► server: binding found, role = lecturer
   └─► pending activation (expires in 2 min) + live pop-up + urgent push to the lecturer
Lecturer confirms in the app (optional: course, open check-in, room status)
   └─► check-in session with rotating code · room status set · device gets session.started
Students tap cards ─► checked in (method: nfc_device) · or type the live code on their phone
End (in the app or the device's end button) ─► session closed · room → open · session.ended
```

## Admin API (cookie-authenticated, admin role)

`GET /api/devices` · `POST /api/devices {name, kind, room}` → returns the credentials once · `PATCH /api/devices/:id` · `POST /api/devices/:id/rotate` · `DELETE /api/devices/:id` (revoke) · `POST /api/devices/:id/commands {type, text}` · `GET /api/devices/:id/events` · `POST /api/devices/:id/pair {user_id, consent: true}` (lecturers can pair themselves or their students).

Kinds: `puck`, `nfc_reader`, `door_light`, `display`.

## Production notes

- Serve Campus OS over HTTPS. Devices should verify the server certificate.
- Keep device clocks synced (NTP), or requests fail the 120 s window.
- Store the secret in the device's protected storage, never in a public repo. Rotate it from the admin screen if a device is lost.
- Equipment control (projectors and the like) isn't built. Add new command types in `src/modules/devices/routes.js` with explicit permission checks.
