# Live speech recognition

Campus OS can use **Deepgram Nova-3** for live dictation, the wake phrase, voice conversations and captions. Automatic language mode decodes German and English together, including switches within a sentence. Fixed German and English choices remain available. Text-to-speech still uses the existing voice system.

## Activation

The deployment owner configures these settings in the hosting dashboard. Agents must not inspect or change private configuration files.

| Setting | Value |
|---|---|
| `DEEPGRAM_API_KEY` | A Deepgram project key with Member permission or higher, required by `/v1/auth/grant`. Keep it server-side. |
| `CAMPUS_STT_PROVIDER` | `deepgram` or `browser`. With no explicit setting, a configured Deepgram key selects Deepgram; otherwise the browser is used. |
| `CAMPUS_STT_REGION` | `eu` (default) or `global`. EU uses `api.eu.deepgram.com`. |

Enable the AI provider for the institution in Admin / AI & knowledge and redeploy after setting the hosting variables. Deepgram is a separate paid service; its account needs sufficient credits. No new runtime dependencies are installed.

Settings / Assistant shows the active recognition system. While the wake phrase is enabled, audio streams continuously to the selected recognition service, including while waiting for the wake phrase. Turning listening off closes the stream and releases the microphone. Browser microphone permission is still required. Native browser recognition remains the fallback if Deepgram is unavailable and the browser supports it; the app shows a notice when falling back.

## Audio and authentication

- Microphone capture requests the browser's established WebRTC echo cancellation, noise suppression, automatic gain control and mono audio. Actual audio processing depends on browser/hardware support. Deepgram also handles background noise in its recognition model. There is no extra custom denoising model or speaker identification.
- `POST /api/speech/recognition-session` requires a signed-in user, validates the requested language, honors the institution's AI-off setting and limits each user's session grants to six per minute.
- The call goes through `deps.ai.recognitionSession`. Only the server reads the project key. It exchanges it for a 30-second temporary token; the browser holds that token only in memory and uses the WebSocket authentication subprotocol. The response is `no-store`.
- Microphone permission is obtained before requesting the temporary token. Audio streams as MediaRecorder container chunks directly to the selected Deepgram region. Campus OS stores neither the audio nor the token. Existing chat/caption text follows its existing storage behavior. `mip_opt_out=true` is sent to Deepgram; its account terms and retention controls still apply.
- The client rotates streams after two minutes, flushes the last audio before closing, releases tracks on abort/error, bounds buffered audio, and reuses the existing reconnect/turn-taking behavior. A grant must be valid at connection time; an established WebSocket can outlive the token's expiry.

## Verify after activation

1. In Settings / Assistant, select Automatic voice input. Allow the microphone.
2. Dictate “Ich brauche my timetable für morgen” and check the live text in both languages.
3. Test the wake phrase, a conversation, a pause, an interruption, and stopping listening. Confirm the browser's microphone indicator switches off when stopped.
4. Test with ordinary room noise and headphones/speakers. Compare recognition with the browser fallback before making accuracy or latency claims.

Automated tests use simulated provider and browser events. A real Deepgram key and microphone are needed for the final live check.

Official references: [Nova-3 language switching](https://developers.deepgram.com/docs/nova-3-language-prompting), [temporary authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication), [live audio API](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [audio preprocessing](https://developers.deepgram.com/guides/deep-dives/audio-preprocessing-barge-in).
