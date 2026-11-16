# Citrus for Android

The Citrus web app in an Android app, for one thing a website cannot do on a phone: **keep recording a lecture
or meeting when the screen turns off, when you switch apps, and after you close the app.**

## What it does

- Opens your Citrus address in a full-screen web view (signed in like the browser; links to other sites open
  in the browser).
- When you start listening in a live lecture or a meeting, it shows a notification ("Citrus keeps listening in
  the background") with a **Stop** button.
- While the app is on screen, the page listens as usual. When the screen turns off, you switch apps or you close
  the app, the app records instead: 30-second pieces of AAC audio that it sends to the server
  (`POST /api/live/sessions/:id/audio`, `POST /api/workspaces/:id/audio`). The server turns them into transcript
  lines at the times they were said. It keeps the lecture audio only when it has file storage (a Vercel Blob store)
  and the lecturer keeps the transcript; the pieces then download as one recording from the review. Back on screen,
  the page takes over again.
- A piece that cannot be sent (no connection) stays on the phone and goes with the next one. When the lecture
  ends, the recording stops by itself.
- Android's web view has no built-in speech recognition. Without cloud recognition set up on the server, the app
  records the whole time and the transcript appears about every 30 seconds.
- Notes (PDF), records (.txt) and recordings are saved to **Downloads**.

The page and the app talk over a private message channel that only the top Citrus page gets, never a frame
inside it (such as a tool someone else made).

iPhone: iOS lets only App Store apps record in the background. In Safari and the home-screen app, Citrus keeps
the screen awake while it listens and resumes by itself when the phone is unlocked; the lecture record marks the
gap.

## Build it

Needs JDK 17 or newer and the Android SDK (Android Studio installs both).

```sh
cd android
./gradlew assembleDebug                                              # opens the live site, https://citrus-mdu.vercel.app
./gradlew assembleDebug -PcampusUrl=https://campus.example.edu      # or another server
./gradlew assembleDebug -PcampusUrl=                                 # or ask for the address on first start
```

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to the phone and open it (allow installing
from this source when Android asks).

GitHub builds it too: **Actions → Android app → the latest run → Artifacts → citrus-android**. It opens the live
site (`campusUrl` in `gradle.properties`); set the repository variable `CAMPUS_URL` to build it for another server.

The debug build is signed with a debug key, which is fine for installing it yourself. For the Play Store, make a
release key and build `assembleRelease`; never commit the key (`*.jks` and `*.keystore` are ignored).

## Files

- `app/src/main/java/app/campusos/android/MainActivity.java`: the web view, the address, permissions, files, and
  handing the microphone between the page and the recording service.
- `app/src/main/java/app/campusos/android/RecordingService.java`: the foreground service that records and sends the
  pieces.
- `public/js/features/native.js`, `public/js/features/keep-awake.js` and `createCaptioner` in
  `public/js/features/voice.js`: the web side.
