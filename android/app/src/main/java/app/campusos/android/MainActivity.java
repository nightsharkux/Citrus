package app.campusos.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Campus OS in an app: the web app in a WebView, plus what a website cannot do on a phone.
 *
 *   - Recording in the background. When the page starts listening to a lecture or meeting, it calls
 *     CampusNative.startRecording({label, target}). The app starts its recording service (a foreground service
 *     with a notification). While the app is on screen the page records as usual; when the screen turns off, the
 *     user switches apps or closes the app, the service records instead and sends the audio to `target` on the
 *     server, which turns it into transcript lines. Back on screen, the page takes over again.
 *   - Saving files (notes as PDF, records as .txt, recordings) to Downloads: CampusNative.saveFile.
 *
 * The page talks to the app over a private message channel (WebMessagePort) that the app hands only to the top
 * page of the Campus OS address it was set up with, never to frames inside it (such as tools other people made).
 */
public class MainActivity extends Activity {
    static final String PREFS = "campus";
    private static final int REQ_MIC = 1;
    private static final int REQ_FILE = 2;
    private static final int REQ_START = 3;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingWebPermission;
    private volatile String trustedHost = "";
    /** How many parts of the page asked to record (listening and a recorder can run together). */
    private int recordings = 0;
    private String label = "Campus OS";
    private String target = "";
    /** The service records even while the app is on screen (the page cannot listen itself). */
    private boolean nativeOnly = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        setUpWebView();
        String url = address();
        if (url.isEmpty()) askForAddress(null);
        else open(url);
    }

    // ---- the address of the Campus OS server --------------------------------------------------------------

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    String address() {
        return prefs().getString("url", BuildConfig.CAMPUS_URL).trim();
    }

    private void open(String url) {
        Uri uri = Uri.parse(url);
        trustedHost = uri.getHost() == null ? "" : uri.getHost();
        web.loadUrl(url);
    }

    private static String normalise(String input) {
        String url = input.trim();
        if (url.isEmpty()) return "";
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    private void askForAddress(String message) {
        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint(R.string.address_hint);
        field.setText(address());
        new AlertDialog.Builder(this)
                .setTitle(R.string.address_title)
                .setMessage(message != null ? message : getString(R.string.address_help))
                .setView(field)
                .setCancelable(false)
                .setPositiveButton(R.string.open, (d, w) -> {
                    String url = normalise(field.getText().toString());
                    if (url.isEmpty() || !url.startsWith("https://")) {
                        askForAddress(getString(R.string.address_help));
                        return;
                    }
                    prefs().edit().putString("url", url).apply();
                    open(url);
                })
                .show();
    }

    // ---- the web view -----------------------------------------------------------------------------------------

    private void setUpWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " CampusOSApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (trustedHost.equals(uri.getHost())) return false;
                // Links elsewhere (official university pages, maps) open in the browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // no browser
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                connect(url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.unreachable)
                        .setMessage(error.getDescription())
                        .setPositiveButton(R.string.retry, (d, w) -> web.reload())
                        .setNegativeButton(R.string.change_address, (d, w) -> askForAddress(null))
                        .show();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsMic = false;
                    for (String r : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
                    if (!wantsMic || !trustedHost.equals(request.getOrigin().getHost())) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingWebPermission = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(intent, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        // Files the server sends (the lecture record, minutes as .txt): through the download manager, signed in.
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (!url.startsWith("https://")) return; // blob: and data: files come through CampusNative.saveFile
            String name = URLUtil.guessFileName(url, disposition, mime);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
            r.addRequestHeader("User-Agent", userAgent);
            r.setMimeType(mime);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            else r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        });
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != REQ_FILE || fileCallback == null) return;
        Uri[] picked = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) picked[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request == REQ_START) {
            boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            if (!mic) {
                Toast.makeText(this, R.string.mic_needed, Toast.LENGTH_LONG).show();
                return;
            }
            if (recordings > 0) {
                startForegroundService(service(RecordingService.ACTION_STANDBY));
                if (nativeOnly) startService(service(RecordingService.ACTION_CAPTURE));
            }
            return;
        }
        if (request == REQ_MIC && pendingWebPermission != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pendingWebPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingWebPermission.deny();
                Toast.makeText(this, R.string.mic_needed, Toast.LENGTH_LONG).show();
            }
            pendingWebPermission = null;
        }
    }

    // ---- recording in the background ---------------------------------------------------------------------

    private Intent service(String action) {
        Intent i = new Intent(this, RecordingService.class).setAction(action);
        i.putExtra("base", address());
        i.putExtra("label", label);
        i.putExtra("target", target);
        return i;
    }

    private void beginRecording(String newLabel, String newTarget) {
        recordings++;
        if (newLabel != null && !newLabel.isEmpty()) label = newLabel;
        if (newTarget != null && !newTarget.isEmpty()) target = newTarget;
        boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean notify = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        if (!mic || !notify) {
            requestPermissions(Build.VERSION.SDK_INT >= 33
                    ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                    : new String[]{Manifest.permission.RECORD_AUDIO}, REQ_START);
            if (!mic) return; // the service starts once the microphone is allowed
        }
        startForegroundService(service(RecordingService.ACTION_STANDBY));
    }

    private void endRecording() {
        recordings = Math.max(0, recordings - 1);
        if (recordings > 0) return;
        target = "";
        nativeOnly = false;
        startService(new Intent(this, RecordingService.class).setAction(RecordingService.ACTION_STOP));
    }

    private void tellPage(String event) {
        web.evaluateJavascript("window.dispatchEvent(new Event('" + event + "'))", null);
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Off screen (screen off, another app, or closing): the service records, the page pauses its microphone.
        if (recordings > 0 && !nativeOnly && !isChangingConfigurations()) {
            tellPage("campus-native-background");
            startService(service(RecordingService.ACTION_CAPTURE));
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (recordings > 0 && !nativeOnly) {
            startService(service(RecordingService.ACTION_RELEASE));
            tellPage("campus-native-foreground");
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        // If a recording is running, the service keeps recording on its own until it is stopped or the lecture ends.
        web.destroy();
        super.onDestroy();
    }

    // ---- files ---------------------------------------------------------------------------------------------------

    private void saveToDownloads(String name, String mime, byte[] bytes) throws Exception {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]+", "-");
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
            v.put(MediaStore.Downloads.MIME_TYPE, mime);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IllegalStateException("No Downloads folder");
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                out.write(bytes);
            }
        } else {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            try (OutputStream out = new FileOutputStream(new File(dir, safe))) {
                out.write(bytes);
            }
        }
    }

    // ---- what the page can ask for -------------------------------------------------------------------------

    private WebMessagePort appPort;

    /**
     * After each full page load on the Campus OS address: a fresh private channel, posted to the top page only
     * (postWebMessage delivers it only when the top page has exactly this origin).
     */
    private void connect(String url) {
        Uri page = Uri.parse(url);
        if (!"https".equals(page.getScheme()) || !trustedHost.equals(page.getHost())) return;
        if (appPort != null) appPort.close();
        WebMessagePort[] ports = web.createWebMessageChannel();
        appPort = ports[0];
        appPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort port, WebMessage message) {
                handle(message.getData());
            }
        });
        web.postWebMessage(new WebMessage("campus-native", new WebMessagePort[]{ports[1]}), Uri.parse("https://" + trustedHost));
    }

    /** {"cmd": "start", "label", "target"} | {"cmd": "stop"} | {"cmd": "save", "name", "mime", "data" (base64)} */
    private void handle(String data) {
        try {
            JSONObject o = new JSONObject(data);
            switch (o.optString("cmd")) {
                case "start": {
                    String t = o.optString("target", "");
                    beginRecording(o.optString("label", ""), t.startsWith("/api/") ? t : "");
                    break;
                }
                case "capture":
                    // The page cannot listen itself (no speech recognition in the web view): record the whole time.
                    nativeOnly = true;
                    if (recordings > 0 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        startService(service(RecordingService.ACTION_CAPTURE));
                    }
                    break;
                case "stop":
                    endRecording();
                    break;
                case "save": {
                    String name = o.optString("name", "campus-os-file");
                    String mime = o.optString("mime", "application/octet-stream");
                    byte[] bytes = Base64.decode(o.optString("data", ""), Base64.DEFAULT);
                    new Thread(() -> {
                        try {
                            saveToDownloads(name, mime, bytes);
                            runOnUiThread(() -> Toast.makeText(this, getString(R.string.saved_to_downloads, name), Toast.LENGTH_LONG).show());
                        } catch (Exception e) {
                            runOnUiThread(() -> Toast.makeText(this, String.valueOf(e.getMessage()), Toast.LENGTH_LONG).show());
                        }
                    }).start();
                    break;
                }
                default:
                    break;
            }
        } catch (Exception ignored) {
            // not a command
        }
    }
}
