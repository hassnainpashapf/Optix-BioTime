package pk.attendance.alerts;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Keeps one long request open to the attendance server (GET /api/m/feed?wait=20) and turns every new alert into a phone notification.
 * The server answers as soon as something happens, so there is no polling every few seconds and no third-party push service.
 */
public class AlertService extends Service {
    static final String CH_STATUS = "status", CH_ALERTS = "alerts", CH_QUIET = "alerts_quiet";
    private volatile boolean running;
    private Thread worker;

    static void start(Context c) {
        Intent i = new Intent(c, AlertService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }
    static void stop(Context c) { c.stopService(new Intent(c, AlertService.class)); }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        channels();
        Notification n = new Notification.Builder(this, CH_STATUS).setSmallIcon(R.drawable.ic_stat).setContentTitle("Optix Alerts")
            .setContentText("Listening for alerts").setContentIntent(open()).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE); else startForeground(1, n);
        if (worker == null || !worker.isAlive()) { running = true; worker = new Thread(this::loop, "alert-listener"); worker.start(); }
        return START_STICKY;
    }

    @Override public void onDestroy() { running = false; if (worker != null) worker.interrupt(); super.onDestroy(); }

    private void loop() {
        long backoff = 5000;
        while (running) {
            try {
                if (!Session.paired(this)) { stopSelf(); return; }
                long since = Session.since(this);
                if (since < 0) { // first run after pairing: start from now
                    JSONObject me = get("/api/m/me", 15000);
                    Session.saveSince(this, me.optLong("latest", 0)); continue;
                }
                JSONObject r = get("/api/m/feed?since=" + since + "&wait=20&limit=30", 35000);
                JSONArray items = r.optJSONArray("items");
                if (items != null && items.length() > 0) { show(items); Session.saveSince(this, r.optLong("latest", since)); }
                backoff = 5000;
            } catch (UnauthorizedException e) {
                Session.clear(this); notifyOnce("This phone was disconnected", "Open Optix Alerts and pair it again."); stopSelf(); return;
            } catch (InterruptedException e) { return;
            } catch (Exception e) {
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 60000);
            }
        }
    }

    private static class UnauthorizedException extends Exception {}

    private JSONObject get(String path, int readTimeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(Session.server(this) + path).openConnection();
        try {
            c.setConnectTimeout(10000); c.setReadTimeout(readTimeout);
            c.setRequestProperty("Authorization", "Bearer " + Session.token(this));
            int code = c.getResponseCode();
            if (code == 401) throw new UnauthorizedException();
            if (code != 200) throw new Exception("HTTP " + code);
            StringBuilder sb = new StringBuilder(); String line;
            try (BufferedReader b = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) { while ((line = b.readLine()) != null) sb.append(line); }
            return new JSONObject(sb.toString());
        } finally { c.disconnect(); }
    }

    /** Newest first from the server; shown oldest first, at most 5 separately, then one summary. */
    private void show(JSONArray items) throws Exception {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        int n = items.length(), single = Math.min(n, 5);
        for (int i = single - 1; i >= 0; i--) {
            JSONObject it = items.getJSONObject(i);
            boolean quiet = it.optBoolean("silent", false);
            Notification.Builder b = new Notification.Builder(this, quiet ? CH_QUIET : CH_ALERTS).setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(it.optString("title")).setContentText(it.optString("body")).setStyle(new Notification.BigTextStyle().bigText(it.optString("body")))
                .setSubText(it.optString("label")).setContentIntent(open()).setAutoCancel(true).setGroup("alerts");
            nm.notify(1000 + (int) (it.optLong("id") % 100000), b.build());
        }
        if (n > single) {
            Notification s = new Notification.Builder(this, CH_ALERTS).setSmallIcon(R.drawable.ic_stat).setContentTitle((n - single) + " more alerts")
                .setContentText("Open Optix Alerts to read them").setContentIntent(open()).setAutoCancel(true).setGroup("alerts").build();
            nm.notify(999, s);
        }
    }

    private void notifyOnce(String title, String text) {
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(998, new Notification.Builder(this, CH_ALERTS).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title).setContentText(text).setContentIntent(open()).setAutoCancel(true).build());
    }

    private PendingIntent open() {
        return PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void channels() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CH_STATUS, "Connection", NotificationManager.IMPORTANCE_MIN));
        nm.createNotificationChannel(new NotificationChannel(CH_ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH));
        NotificationChannel q = new NotificationChannel(CH_QUIET, "Alerts in quiet hours (no sound)", NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(q);
    }
}
