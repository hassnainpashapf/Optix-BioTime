package pk.attendance.alerts;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts listening again after the phone restarts or the app is updated. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (Session.paired(context)) AlertService.start(context);
    }
}
