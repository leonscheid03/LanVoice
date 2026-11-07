package de.lanvoice.app

import android.content.Context
import android.view.View
import android.webkit.WebView

/**
 * WebView, das der Seite nie meldet, sie sei unsichtbar.
 *
 * Sobald die Activity im Hintergrund ist, setzt Android das Fenster auf "unsichtbar", und Chromium
 * behandelt die Seite dann wie einen verdeckten Tab: Timer werden gedrosselt, Medien pausiert. Für
 * einen Voicechat ist das genau falsch. Wir geben die Sichtbarkeit deshalb immer als "sichtbar" weiter.
 * Das Mikrofon selbst erlaubt Android im Hintergrund nur wegen des Vordergrunddienstes (VoiceService).
 */
class KeepAliveWebView(context: Context) : WebView(context) {
    override fun onWindowVisibilityChanged(visibility: Int) {
        if (visibility != View.GONE) super.onWindowVisibilityChanged(View.VISIBLE)
    }
}
