package pk.attendance.alerts;

import android.content.Context;
import android.content.SharedPreferences;

/** The server address and the pairing token of this phone, kept on the phone only. */
final class Session {
    private static SharedPreferences p(Context c) { return c.getSharedPreferences("session", Context.MODE_PRIVATE); }

    static String server(Context c) { return p(c).getString("server", ""); }
    static String token(Context c) { return p(c).getString("token", ""); }
    static long since(Context c) { return p(c).getLong("since", -1); }
    static boolean paired(Context c) { return !server(c).isEmpty() && !token(c).isEmpty(); }

    static void save(Context c, String server, String token) {
        SharedPreferences.Editor e = p(c).edit().putString("server", server).putString("token", token);
        if (!token.equals(token(c))) e.putLong("since", -1); // a new pairing starts from "now": old alerts are not replayed
        e.apply();
    }
    static void saveServer(Context c, String server) { p(c).edit().putString("server", server).apply(); }
    static void saveSince(Context c, long id) { p(c).edit().putLong("since", id).apply(); }
    static void clear(Context c) { p(c).edit().remove("token").remove("since").apply(); }
}
