package de.lanvoice.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.security.MessageDigest

/**
 * Dünne Hülle um die LanVoice-Weboberfläche:
 *  - Die Seite kommt immer vom eigenen Server (aktuell ohne App-Update).
 *  - Das selbst signierte Zertifikat wird beim ersten Mal per Fingerabdruck bestätigt und gemerkt
 *    (statt Browser-Warnung). Ändert es sich, wird erneut gefragt.
 *  - Läuft man im Raum, hält ein Vordergrunddienst (VoiceService) Mikrofon und Verbindung im Hintergrund am Leben.
 */
class MainActivity : Activity() {
    private lateinit var prefs: SharedPreferences
    private lateinit var root: FrameLayout
    private lateinit var web: KeepAliveWebView
    private lateinit var connectView: View
    private lateinit var addressInput: EditText
    private lateinit var messageText: TextView
    private val handler = Handler(Looper.getMainLooper())

    private var serverKey: String? = null // "host:port" des Servers, mit dem wir verbunden sind
    private var serverOrigin: String? = null // "https://host:port"
    private val pendingSslHandlers = mutableListOf<SslErrorHandler>()
    private var pendingMicRequest: PermissionRequest? = null
    private var quitting = false

    private val quitReceiver = object : BroadcastReceiver() {
        // "Verlassen" in der Benachrichtigung: erst den Raum sauber verlassen, dann beenden.
        override fun onReceive(context: Context, intent: Intent) {
            web.evaluateJavascript("(function(){var b=document.getElementById('leave-btn');if(b)b.click();})()", null)
            handler.postDelayed({
                quitting = true
                finishAndRemoveTask()
            }, 700)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("lanvoice", MODE_PRIVATE)
        // chrome://inspect nur bei Debug-Builds
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)

        root = FrameLayout(this)
        root.setBackgroundColor(themeBackground())
        // Ab Android 15 zeichnet die App unter Status- und Navigationsleiste: Abstände selbst setzen.
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
                v.setPadding(i.left, i.top, i.right, i.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }

        web = buildWebView()
        connectView = buildConnectView()
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(connectView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        registerReceiver(quitReceiver, IntentFilter(VoiceService.ACTION_QUIT), RECEIVER_NOT_EXPORTED)
        requestStartupPermissions()

        val saved = prefs.getString("server", null)
        if (saved != null) connect(saved) else showConnect()
    }

    override fun onDestroy() {
        unregisterReceiver(quitReceiver)
        stopVoiceService()
        root.removeView(web)
        web.destroy()
        super.onDestroy()
        if (quitting) Process.killProcess(Process.myPid()) // sicherstellen, dass nichts weiterläuft
    }

    // Zurück-Taste beendet die App nicht, sondern schiebt sie in den Hintergrund (Sprachverbindung bleibt).
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    // ---------- Aufbau der Ansichten ----------

    private fun themeBackground(): Int {
        val tv = TypedValue()
        theme.resolveAttribute(android.R.attr.colorBackground, tv, true)
        return tv.data
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildWebView(): KeepAliveWebView {
        val view = KeepAliveWebView(this)
        view.visibility = View.GONE
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // sessionStorage/localStorage für Token und Einstellungen
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            safeBrowsingEnabled = false // keine Anfragen an Google im lokalen Netz
        }
        // Renderer-Prozess nicht als "unwichtig" einstufen, damit Android ihn im Hintergrund nicht zuerst beendet.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        view.addJavascriptInterface(NativeBridge(), "LanVoiceNative")
        view.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val key = serverKey
                val fingerprint = fingerprint(error.certificate)
                if (key == null || fingerprint == null) return handler.cancel()
                val saved = prefs.getString("pin:$key", null)
                if (saved == fingerprint) handler.proceed() else askToTrust(key, fingerprint, saved != null, handler)
            }

            // Nur der eigene Server darf geladen werden (die JavaScript-Brücke gilt für alles in dieser WebView).
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                originOf(request.url) != serverOrigin

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    showConnect("Server nicht erreichbar (${error.description}). Läuft er, und seid ihr im selben WLAN?")
                }
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleWebPermission(request) }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingMicRequest == request) pendingMicRequest = null
            }
        }
        return view
    }

    private fun buildConnectView(): View {
        val title = TextView(this).apply {
            text = "LanVoice"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }
        val subtitle = TextView(this).apply { text = "Mit deinem LanVoice-Server verbinden" }
        addressInput = EditText(this).apply {
            hint = "192.168.2.126:8443"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
            imeOptions = EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, _, _ ->
                onConnectClicked()
                true
            }
        }
        val connectButton = Button(this).apply {
            text = "Verbinden"
            setOnClickListener { onConnectClicked() }
        }
        messageText = TextView(this).apply { setTextColor(0xFFD93025.toInt()) }
        val hint = TextView(this).apply {
            text = "Die Adresse steht im Terminal des Servers (z. B. 192.168.2.126:8443). Ohne Port wird 8443 benutzt."
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        val batteryButton = Button(this).apply {
            text = "Akku-Optimierung ausschalten"
            setOnClickListener { requestBatteryExemption() }
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
            val gap = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
            addView(title)
            addView(subtitle)
            addView(addressInput, gap)
            addView(connectButton, gap)
            addView(messageText, gap)
            addView(hint, gap)
            addView(batteryButton, gap)
        }
        return ScrollView(this).apply {
            isFillViewport = true
            addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    // ---------- Verbinden ----------

    private fun onConnectClicked() {
        val address = normalizeAddress(addressInput.text.toString())
        if (address == null) {
            messageText.text = "Bitte eine Adresse wie 192.168.2.126:8443 eingeben."
            return
        }
        connect(address)
    }

    /** "https://192.168.2.126/" -> "192.168.2.126:8443"; null bei ungültiger Eingabe. */
    private fun normalizeAddress(input: String): String? {
        var s = input.trim().lowercase().removePrefix("https://").removePrefix("http://").substringBefore('/')
        if (!Regex("^[a-z0-9.-]{1,253}(:\\d{1,5})?$").matches(s)) return null
        if (!s.contains(':')) s += ":8443"
        val port = s.substringAfter(':').toInt()
        return if (port in 1..65535) s else null
    }

    private fun connect(address: String) {
        prefs.edit().putString("server", address).apply()
        val (host, port) = address.split(':')
        serverKey = address
        serverOrigin = "https://$host:$port"
        messageText.text = ""
        connectView.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl("https://$address/")
    }

    private fun showConnect(message: String? = null) {
        stopVoiceService()
        web.visibility = View.GONE
        web.loadUrl("about:blank") // beendet die Seite und damit Mikrofon und Verbindung
        addressInput.setText(prefs.getString("server", ""))
        messageText.text = message.orEmpty()
        connectView.visibility = View.VISIBLE
    }

    private fun originOf(uri: Uri): String = "${uri.scheme}://${uri.host}:${if (uri.port == -1) 443 else uri.port}"

    // ---------- Zertifikat ----------

    private fun fingerprint(cert: SslCertificate?): String? {
        val der = cert?.x509Certificate?.encoded ?: return null
        return MessageDigest.getInstance("SHA-256").digest(der).joinToString(":") { "%02X".format(it) }
    }

    private fun askToTrust(key: String, fingerprint: String, changed: Boolean, handler: SslErrorHandler) {
        pendingSslHandlers += handler
        if (pendingSslHandlers.size > 1) return // der Dialog ist schon offen
        val extra = if (changed) "\n\nDas passiert normalerweise, wenn sich die IP-Adresse des Servers geändert hat." else ""
        AlertDialog.Builder(this)
            .setTitle(if (changed) "Zertifikat hat sich geändert" else "Diesem Server vertrauen?")
            .setMessage(
                "SHA-256-Fingerabdruck:\n\n$fingerprint\n\n" +
                    "Vergleiche ihn mit der Zeile \"Zertifikat-Fingerabdruck\" im Terminal des Servers. " +
                    "Nur vertrauen, wenn beide übereinstimmen.$extra",
            )
            .setCancelable(false)
            .setPositiveButton("Vertrauen") { _, _ ->
                prefs.edit().putString("pin:$key", fingerprint).apply()
                pendingSslHandlers.forEach { it.proceed() }
                pendingSslHandlers.clear()
            }
            .setNegativeButton("Abbrechen") { _, _ ->
                pendingSslHandlers.forEach { it.cancel() }
                pendingSslHandlers.clear()
                showConnect("Zertifikat nicht bestätigt.")
            }
            .show()
    }

    // ---------- Berechtigungen ----------

    private fun requestStartupPermissions() {
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isNotEmpty()) requestPermissions(wanted.toTypedArray(), REQ_STARTUP)
    }

    /** Die Seite will das Mikrofon: nur für den eigenen Server und nur Audio. */
    private fun handleWebPermission(request: PermissionRequest) {
        val audio = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }.toTypedArray()
        if (originOf(request.origin) != serverOrigin || audio.isEmpty()) return request.deny()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(audio)
        } else {
            pendingMicRequest?.deny()
            pendingMicRequest = request
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        val pending = pendingMicRequest ?: return
        pendingMicRequest = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            pending.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            pending.deny()
            Toast.makeText(this, "Ohne Mikrofon-Berechtigung kann man nicht sprechen.", Toast.LENGTH_LONG).show()
        }
    }

    // ---------- Vordergrunddienst, Akku ----------

    /** Brücke zur Seite (window.LanVoiceNative): sagt der App, wann man im Raum ist. */
    private inner class NativeBridge {
        @JavascriptInterface
        fun setActive(active: Boolean, room: String?) {
            runOnUiThread { if (active) startVoiceService(room) else stopVoiceService() }
        }

        @JavascriptInterface
        fun changeServer() {
            runOnUiThread { showConnect() }
        }
    }

    private fun startVoiceService(room: String?) {
        try {
            startForegroundService(Intent(this, VoiceService::class.java).putExtra(VoiceService.EXTRA_ROOM, room.orEmpty().take(64)))
        } catch (e: Exception) {
            Toast.makeText(this, "Der Hintergrunddienst konnte nicht starten.", Toast.LENGTH_LONG).show()
        }
        askForBatteryExemptionOnce()
    }

    private fun stopVoiceService() {
        stopService(Intent(this, VoiceService::class.java))
    }

    private fun askForBatteryExemptionOnce() {
        val power = getSystemService(PowerManager::class.java)
        if (power.isIgnoringBatteryOptimizations(packageName) || prefs.getBoolean("batteryAsked", false)) return
        prefs.edit().putBoolean("batteryAsked", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Im Hintergrund weiterlaufen")
            .setMessage("Damit LanVoice auch bei dunklem Bildschirm zuverlässig läuft, sollte die Akku-Optimierung für die App ausgeschaltet sein.")
            .setPositiveButton("Einstellen") { _, _ -> requestBatteryExemption() }
            .setNegativeButton("Nicht jetzt", null)
            .show()
    }

    private fun requestBatteryExemption() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (e2: Exception) {
                Toast.makeText(this, "Bitte die Akku-Optimierung in den Android-Einstellungen ausschalten.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private companion object {
        const val REQ_STARTUP = 1
        const val REQ_MIC = 2
    }
}
