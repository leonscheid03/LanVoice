package de.lanvoice.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Vordergrunddienst, der läuft, solange man im Raum ist.
 *
 * Was er bewirkt:
 *  - Android erlaubt einer App im Hintergrund nur dann Mikrofonzugriff, wenn ein Vordergrunddienst vom
 *    Typ "microphone" läuft (dauerhafte Benachrichtigung inklusive).
 *  - Ein Wake Lock hält die CPU wach, eine WLAN-Sperre verhindert, dass das WLAN bei dunklem Bildschirm
 *    einschläft (das war die Ursache für lange Wiederverbindungszeiten nach Standby).
 *
 * Gestartet wird der Dienst von MainActivity, während die App sichtbar ist (aus dem Hintergrund
 * dürfte Android ihn nicht mehr mit Mikrofon starten).
 */
class VoiceService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // "Verlassen" in der Benachrichtigung: Activity soll den Raum sauber verlassen und sich beenden.
            sendBroadcast(Intent(ACTION_QUIT).setPackage(packageName))
            stopSelf()
            return START_NOT_STICKY
        }

        val room = intent?.getStringExtra(EXTRA_ROOM).orEmpty().ifBlank { "Voicechat" }.take(64)
        try {
            startForeground(NOTIFICATION_ID, buildNotification(room), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (e: Exception) {
            // z. B. Mikrofon-Berechtigung fehlt oder die App ist nicht (mehr) im Vordergrund
            stopSelf()
            return START_NOT_STICKY
        }
        acquireLocks()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseLocks()
        super.onDestroy()
    }

    private fun buildNotification(room: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "LanVoice im Raum", NotificationManager.IMPORTANCE_LOW),
        )

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, VoiceService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val leave = Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_notification), "Verlassen", stop).build()

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("LanVoice")
            .setContentText("Im Raum \"$room\" – Mikrofon aktiv")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(open)
            .addAction(leave)
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return builder.build()
    }

    private fun acquireLocks() {
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            // Sicherheitsgrenze: nach 12 Stunden gibt Android die Sperre selbst frei.
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lanvoice:voice").apply {
                setReferenceCounted(false)
                acquire(12 * 60 * 60 * 1000L)
            }
        }
        if (wifiLock == null) {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "lanvoice:wifi").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseLocks() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        wifiLock = null
    }

    companion object {
        const val ACTION_STOP = "de.lanvoice.app.STOP"
        const val ACTION_QUIT = "de.lanvoice.app.QUIT"
        const val EXTRA_ROOM = "room"
        private const val CHANNEL_ID = "voice"
        private const val NOTIFICATION_ID = 1
    }
}
