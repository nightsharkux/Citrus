package app.citrus.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.CookieManager;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Records the lecture or meeting while Citrus is off screen: the screen is off, the user switched apps, or the
 * app was closed. A foreground service (with a notification and a Stop button), so Android lets it use the
 * microphone in the background.
 *
 *   standby  the page is recording on screen; the service only keeps its notification, ready to take over
 *   capture  off screen: record 30-second pieces (AAC, mono, 16 kHz) and send each to the server's `target`
 *            (POST /api/live/sessions/:id/audio or /api/workspaces/:id/audio), signed in with the app's cookies.
 *            The server turns them into transcript lines at the times they were said and keeps no audio.
 *   release  back on screen: send the last piece and let the page record again
 *   stop     the page stopped listening, or the user tapped Stop
 *
 * A piece that cannot be sent (no connection) stays on the phone and is sent with the next one. When the lecture
 * has ended (the server answers 409) or access is gone, the service stops by itself.
 */
public class RecordingService extends Service {
    static final String ACTION_STANDBY = "app.citrus.android.STANDBY";
    static final String ACTION_CAPTURE = "app.citrus.android.CAPTURE";
    static final String ACTION_RELEASE = "app.citrus.android.RELEASE";
    static final String ACTION_STOP = "app.citrus.android.STOP";
    private static final String CHANNEL = "recording";
    private static final int NOTIFICATION = 7;
    private static final int PIECE_MS = 30_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService uploads = Executors.newSingleThreadExecutor();
    private String base = "";
    private String label = "Citrus";
    private String target = "";
    private MediaRecorder recorder;
    private File piece;
    private long pieceStarted;
    private boolean capturing;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null || intent.getAction() == null ? ACTION_STANDBY : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopEverything();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.hasExtra("base")) {
            base = intent.getStringExtra("base");
            label = intent.getStringExtra("label");
            target = intent.getStringExtra("target");
        }
        try {
            goForeground();
        } catch (RuntimeException e) {
            // Not allowed right now (no microphone permission, or started from the background): do nothing.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_CAPTURE.equals(action)) startCapture();
        else if (ACTION_RELEASE.equals(action)) stopCapture();
        return START_NOT_STICKY;
    }

    /** The app was swiped away: keep recording if a lecture or meeting is on. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (target != null && !target.isEmpty()) startCapture();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        stopCapture();
        uploads.shutdown();
        super.onDestroy();
    }

    // ---- the notification --------------------------------------------------------------------------------

    private void goForeground() {
        Notification n = notification();
        if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(NOTIFICATION, n);
    }

    private Notification notification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.channel_recording), NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, RecordingService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_recording)
                .setContentTitle(getString(capturing ? R.string.recording_title : R.string.standby_title))
                .setContentText(label)
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, getString(R.string.stop), stop).build())
                .build();
    }

    private void refresh() {
        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification());
    }

    // ---- recording in pieces -----------------------------------------------------------------------------

    private void startCapture() {
        if (capturing || target == null || target.isEmpty()) return;
        capturing = true;
        PowerManager pm = getSystemService(PowerManager.class);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Citrus:recording");
        wakeLock.acquire(4 * 60 * 60 * 1000L);
        nextPiece();
        refresh();
    }

    private void nextPiece() {
        try {
            piece = new File(getCacheDir(), "piece-" + System.currentTimeMillis() + ".aac");
            recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            // ADTS: pieces joined end to end are still one valid AAC file, so the server can offer the whole recording.
            recorder.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1);
            recorder.setAudioSamplingRate(16_000);
            recorder.setAudioEncodingBitRate(32_000);
            recorder.setOutputFile(piece.getAbsolutePath());
            recorder.setMaxDuration(PIECE_MS);
            recorder.setOnInfoListener((mr, what, extra) -> {
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) main.post(this::rotate);
            });
            recorder.prepare();
            recorder.start();
            pieceStarted = System.currentTimeMillis();
        } catch (Exception e) {
            // The microphone is busy or not allowed: stop capturing, keep the notification.
            if (recorder != null) recorder.release();
            recorder = null;
            capturing = false;
            releaseWakeLock();
            refresh();
        }
    }

    private void rotate() {
        finishPiece();
        if (capturing) nextPiece();
    }

    private void finishPiece() {
        if (recorder == null) return;
        long duration = System.currentTimeMillis() - pieceStarted;
        boolean ok = true;
        try {
            recorder.stop();
        } catch (RuntimeException e) {
            ok = false; // too short to hold any audio
        }
        recorder.release();
        recorder = null;
        File done = piece;
        if (!ok) {
            done.delete();
            return;
        }
        final long started = pieceStarted;
        final String to = base + target;
        uploads.execute(() -> sendAll(done, started, duration, to));
    }

    private void stopCapture() {
        if (!capturing) return;
        capturing = false;
        finishPiece();
        releaseWakeLock();
        refresh();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void stopEverything() {
        stopCapture();
        target = "";
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    // ---- sending ---------------------------------------------------------------------------------------------

    /** Send this piece, then any older ones that could not be sent before. */
    private void sendAll(File newest, long started, long duration, String url) {
        if (!send(newest, started, duration, url)) return;
        File[] waiting = getCacheDir().listFiles((dir, name) -> name.startsWith("piece-") && name.endsWith(".aac"));
        if (waiting == null) return;
        Arrays.sort(waiting);
        for (File f : waiting) {
            if (f.equals(newest) || (piece != null && f.equals(piece))) continue;
            long at;
            try {
                at = Long.parseLong(f.getName().substring("piece-".length(), f.getName().length() - ".aac".length()));
            } catch (NumberFormatException e) {
                f.delete();
                continue;
            }
            if (!send(f, at, PIECE_MS, url)) return;
        }
    }

    /** True when the server took it (or will never take it); false to try again later. */
    private boolean send(File file, long started, long duration, String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(15_000);
            c.setReadTimeout(90_000);
            c.setRequestProperty("Content-Type", "audio/aac");
            c.setRequestProperty("X-Recorded-At", iso(started));
            c.setRequestProperty("X-Duration-Ms", String.valueOf(duration));
            c.setRequestProperty("Origin", base);
            String cookies = CookieManager.getInstance().getCookie(base);
            if (cookies != null) c.setRequestProperty("Cookie", cookies);
            c.setFixedLengthStreamingMode(file.length());
            try (InputStream in = new FileInputStream(file); OutputStream out = c.getOutputStream()) {
                byte[] buffer = new byte[16 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            }
            int code = c.getResponseCode();
            if (code >= 200 && code < 300) {
                file.delete();
                return true;
            }
            if (code == 409 || code == 401 || code == 403 || code == 404) {
                // The lecture or meeting is over, or this account may not add to it: nothing more to record.
                file.delete();
                main.post(this::stopEverything);
                return true;
            }
            if (code == 400 || code == 413) {
                file.delete(); // the server will never take this piece
                return true;
            }
            return false; // 429, 5xx: keep it and try with the next piece
        } catch (Exception e) {
            return false; // no connection: keep it on the phone
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }
}
