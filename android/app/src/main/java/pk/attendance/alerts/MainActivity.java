package pk.attendance.alerts;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The app is the /m page of your attendance server inside a WebView, plus a background service that shows the alerts as notifications. */
public class MainActivity extends Activity {
    private WebView web;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        if (Session.server(this).isEmpty()) askServer(); else openServer();
        if (Session.paired(this)) { AlertService.start(this); batteryHint(); }
    }

    /** First start: where is the attendance server? */
    private void askServer() {
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(56, 120, 56, 56);
        TextView t = new TextView(this); t.setText("Optix Alerts"); t.setTextSize(24); t.setTextColor(0xFF1c2038);
        TextView h = new TextView(this); h.setText("Type the address of your attendance server, for example 192.168.1.10:8080. Your administrator can tell you.\n"); h.setTextColor(0xFF7b8199); h.setPadding(0, 16, 0, 16);
        EditText e = new EditText(this); e.setHint("192.168.1.10:8080"); e.setInputType(InputType.TYPE_TEXT_VARIATION_URI); e.setText(Session.server(this).replace("http://", "").replace("https://", ""));
        TextView err = new TextView(this); err.setTextColor(0xFFe5484d);
        Button go = new Button(this); go.setText("Continue");
        go.setOnClickListener(v -> {
            String a = e.getText().toString().trim();
            if (a.isEmpty()) { err.setText("Type the server address"); return; }
            if (!a.startsWith("http")) a = "http://" + a;
            Session.saveServer(this, a.replaceAll("/+$", "")); openServer();
        });
        box.addView(t); box.addView(h); box.addView(e); box.addView(err); box.addView(go);
        setContentView(box);
    }

    private void openServer() {
        web = new WebView(this);
        WebSettings s = web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError err) {
                if (r.isForMainFrame()) v.loadData("<body style='font-family:sans-serif;padding:24px'><h2>Cannot reach the server</h2><p>" + Session.server(MainActivity.this) + "</p><p>Check that the phone is on the same network as the server, or tap the button to change the address.</p><p><a href='https://retry.local/'>Try again</a></p></body>", "text/html", "utf-8");
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (r.getUrl().getHost() != null && r.getUrl().getHost().equals("retry.local")) { v.loadUrl(Session.server(MainActivity.this) + "/m"); return true; }
                return false;
            }
        });
        setContentView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(Session.server(this) + "/m");
    }

    private void batteryHint() {
        if (Build.VERSION.SDK_INT < 23) return;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        getSharedPreferences("hints", MODE_PRIVATE).edit().putInt("battery", getSharedPreferences("hints", MODE_PRIVATE).getInt("battery", 0) + 1).apply();
        if (getSharedPreferences("hints", MODE_PRIVATE).getInt("battery", 0) > 2) return; // ask at most twice
        try { startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) { }
    }

    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }

    /** Called by the /m page. */
    class Bridge {
        @JavascriptInterface public void saveSession(String origin, String token) {
            Session.save(MainActivity.this, origin, token); AlertService.start(MainActivity.this);
            runOnUiThread(MainActivity.this::batteryHint);
        }
        @JavascriptInterface public void clearSession() { Session.clear(MainActivity.this); AlertService.stop(MainActivity.this); }
        @JavascriptInterface public void changeServer() { runOnUiThread(() -> { Session.clear(MainActivity.this); AlertService.stop(MainActivity.this); askServer(); }); }
    }
}
