# Speech recognition and playback

Campus OS supports **Wispr Flow's Voice Interface API** and **Deepgram Nova-3** for dictation, the wake phrase, conversations and captions. Automatic mode enables German and English together; fixed German and English choices remain available. Text-to-speech uses the existing AI Gateway or device voice system.

## Activation

The deployment owner configures these settings in the hosting dashboard. Agents must not inspect or change private configuration files.

| Setting | Value |
|---|---|
| `WISPR_FLOW_API_KEY` | Wispr organization API key, server-side only. Requires Wispr-approved Voice Interface API access; a desktop Flow subscription alone does not grant this access. |
| `DEEPGRAM_API_KEY` | A Deepgram project key with Member permission or higher, required by `/v1/auth/grant`. Keep it server-side. |
| `CAMPUS_STT_PROVIDER` | `wispr`, `deepgram` or `browser`. If unset, a configured Wispr key selects Wispr, then a Deepgram key selects Deepgram, otherwise browser recognition. |
| `CAMPUS_STT_REGION` | `eu` (default) or `global`. EU uses `api.eu.deepgram.com`. |

Request Wispr access through its [developer portal](https://platform.wisprflow.ai) and [quickstart](https://api-docs.wisprflow.ai/quickstart). Enable the institution's AI provider in Admin / AI & knowledge and redeploy after setting hosting variables. External recognition is billed by its service. No new runtime dependencies are installed.

Settings / Assistant identifies the configured recognition system. While the wake phrase is enabled, audio streams to the selected service, including while waiting for the wake phrase. Turning listening off closes capture and releases the microphone. HTTPS (or localhost) and microphone permission are required. Native browser recognition is the fallback when supported; the app shows a notice when falling back.

## Audio and authentication

- Microphone capture requests the browser's established WebRTC echo cancellation, noise suppression, automatic gain control and mono audio. Actual audio processing depends on browser/hardware support. Deepgram also handles background noise in its recognition model. There is no extra custom denoising model or speaker identification.
- Bluetooth headphones play everything in muffled call quality while their microphone records. When the default microphone is a headset and the computer has its own, Deepgram and Wispr record from the computer's microphone, so the headphones keep their full sound (public/js/features/microphone.js). When the headset is the only microphone, or the browser's recogniser is used, the voice conversation releases the microphone while Campus talks; tap or press Space to interrupt.
- `POST /api/speech/recognition-session` requires a signed-in user, validates language and honors the institution's AI-off setting. Grants are limited per user/institution: 24 per minute for Wispr, 20 for Deepgram. Phones reopen capture after each answer.
- Wispr requests go through `deps.ai.recognitionSession`. The server exchanges its organization key for a 120-second grant tied to the institution/user. The browser uses Wispr's documented client WebSocket authentication, including the temporary token in the URL and auth message. Capture uses a 16 kHz AudioContext and local AudioWorklet with fixed 50 ms little-endian int16 PCM packets. Unsupported capture rates fall back to browser recognition.
- Wispr receives app identity and a small vocabulary list (campus terms, the user's programme and assistant nickname), without chat history, screenshots or private documents. A local energy detector commits after speech followed by about one second of quiet; manual stop also flushes and commits. Very quiet speech may be missed and loud noise may count as speech. Only final transcripts are emitted, since Wispr can rewrite partial text. It does not provide word-by-word live captions here. Idle streams rotate after 90 seconds and finalization is bounded to eight seconds.
- Deepgram calls go through `deps.ai.recognitionSession`. Only the server reads the project key. It exchanges it for a 30-second temporary token; the browser holds that token only in memory and uses the WebSocket authentication subprotocol. All grant responses are `no-store`.
- Microphone permission is obtained before requesting the temporary token. Audio streams as MediaRecorder container chunks directly to the selected Deepgram region. Campus OS stores neither the audio nor the token. Existing chat/caption text follows its existing storage behavior. `mip_opt_out=true` is sent to Deepgram; its account terms and retention controls still apply.
- The Deepgram client rotates streams after two minutes and sends the same vocabulary as recognition keyterms. Both adapters flush the final audio on stop, release tracks on abort/error, bound buffered audio and reuse existing reconnect/turn-taking behavior. Campus OS does not store recognition audio or grants; existing chat/caption storage and provider retention terms apply.

## Best recognition without waiting for Wispr

Wispr Flow needs approved API access. **Deepgram Nova-3 does not**: create a Deepgram project key (self-serve, free starting credit), set `DEEPGRAM_API_KEY` and leave `CAMPUS_STT_PROVIDER` unset, and Campus uses it automatically for dictation, the wake phrase, conversations and the live lecture. It decodes German and English together, streams words as they are spoken, and the app asks the browser for echo cancellation, noise suppression and gain control.

For lectures, recognition also learns the lecture's vocabulary. When the lecturer opens a live lecture, each recognition session carries its id (`live_session`), and the server sends Deepgram keyterms built by `src/modules/live/vocabulary.js`: the lecture and course titles, the topic names, and terms that stand out in the uploaded notes (acronyms, names, capitalised phrases, repeated technical words), up to 100. Only the lecture's own lecturer receives them. Text is mined from documents (PDF, Word, PowerPoint, text); a photo of a slide has no text to mine. The stream rotates every two minutes, so notes added mid-lecture are picked up at the next rotation.

What this does not do: it does not classify non-speech sounds (applause, a door), identify who is speaking, or remove noise beyond what the browser and Deepgram do. In a large room, accuracy depends mostly on the microphone: a lapel or headset microphone on the lecturer, or a USB conference microphone, beats a laptop microphone at the back. Measure it in the real room before promising accuracy.

## Playback

Generated audio receives bounded per-clip loudness correction and a compressor to reduce volume jumps. Saved volume settings remain in effect. Device playback keeps one voice per language throughout an answer and retries a dropped sentence once. Natural speech requests have bounded timeouts and one retry before device fallback. Supported phones request playback audio routing while the microphone is paused. Campus's gaze stays centered while speaking.

## Verify after activation

1. In Settings / Assistant, select Automatic voice input. Allow the microphone.
2. Dictate “Ich brauche my timetable für morgen” and check the live text in both languages.
3. Test the wake phrase, a conversation, a pause, an interruption, and stopping listening. Confirm the browser's microphone indicator switches off when stopped.
4. Test with ordinary room noise and headphones/speakers. Compare recognition with the browser fallback before making accuracy or latency claims.

With Wispr, pause to finish each phrase. Test names, corrections and quiet speech as well as the bilingual examples. Check short and long replies on the intended speakers/headphones and phone. Automated tests simulate provider and audio events; live approved accounts, a microphone and output device are still needed to measure speed, accuracy and loudness.

Wispr references: [access tokens](https://api-docs.wisprflow.ai/generate_access_token), [client authentication](https://api-docs.wisprflow.ai/client_side_auth_basics), [WebSocket API](https://api-docs.wisprflow.ai/websocket_api), [request schema](https://api-docs.wisprflow.ai/request_schema).

Official references: [Nova-3 language switching](https://developers.deepgram.com/docs/nova-3-language-prompting), [temporary authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication), [live audio API](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [audio preprocessing](https://developers.deepgram.com/guides/deep-dives/audio-preprocessing-barge-in).
