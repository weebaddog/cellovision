package com.cellovision.app

import android.app.Activity
import android.app.UiModeManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
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

/**
 * Cellovision for Android phones and Android TV: the server's app in a WebView (the same pages as
 * everywhere else), with videos handed to the native player (PlayerActivity) for the best formats,
 * remote-control support and picture-in-picture.
 */
class MainActivity : Activity() {
    private lateinit var server: Server
    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private val isTV by lazy { getSystemService(UiModeManager::class.java).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = Server(this)
        root = FrameLayout(this)
        root.setBackgroundColor(Color.rgb(11, 11, 16))
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(b.left, b.top, b.right, b.bottom)
            }
            insets
        }
        setContentView(root)
        if (server.url.isEmpty()) showSetup(null) else showApp()
    }

    override fun onPause() { super.onPause(); CookieManager.getInstance().flush() }

    // ---- choosing a server ------------------------------------------------------------------------

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun text(s: String, size: Float, bold: Boolean = false, color: Int = Color.WHITE) = TextView(this).apply {
        text = s; textSize = size; setTextColor(color); if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD); setPadding(0, dp(6), 0, dp(6))
    }
    private fun button(label: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; setOnClickListener { onClick() }
        if (primary) { setBackgroundColor(Color.rgb(139, 108, 255)); setTextColor(Color.WHITE) }
    }

    private fun showSetup(error: String?) {
        web?.destroy(); web = null
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(28), dp(36), dp(28), dp(28)); gravity = Gravity.CENTER_HORIZONTAL }
        col.addView(text("Cellovision", 30f, true))
        col.addView(text("Watch your movies, shows, music and photos from your Cellovision server. Find it on this Wi-Fi, or type its address.", 16f, color = Color.rgb(163, 161, 182)))
        if (error != null) col.addView(text(error, 15f, color = Color.rgb(255, 123, 123)))
        val input = EditText(this).apply {
            hint = "192.168.1.20"; setSingleLine(); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO; setTextColor(Color.WHITE); setHintTextColor(Color.GRAY)
            setText(server.url.removePrefix("http://").removeSuffix(":${Server.PORT}"))
        }
        val status = text("", 14f, color = Color.rgb(163, 161, 182))
        val found = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fun connect(address: String) {
            var a = address.trim()
            if (a.isEmpty()) return
            if (!a.startsWith("http://") && !a.startsWith("https://")) a = "http://$a"
            val u = Uri.parse(a)
            val base = if (u.port == -1 && u.scheme == "http") "${u.scheme}://${u.host}:${Server.PORT}" else "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
            status.text = "Connecting to ${u.host}…"
            Thread {
                val name = Server.hello(base, 6000)
                runOnUiThread {
                    if (name == null) status.text = "No Cellovision server answered at ${u.host}. Check it's running and on this Wi-Fi."
                    else { server.url = base; showApp() }
                }
            }.start()
        }
        input.setOnEditorActionListener { _, _, _ -> connect(input.text.toString()); true }
        col.addView(input)
        col.addView(button("Connect", primary = true) { connect(input.text.toString()) })
        col.addView(button("Find servers on this Wi-Fi") {
            status.text = "Looking… (a few seconds)"; found.removeAllViews()
            Thread {
                val list = Server.find(this)
                runOnUiThread {
                    status.text = if (list.isEmpty()) "No server answered on this Wi-Fi." else "Found ${list.size}. Pick yours:"
                    for ((base, name) in list) found.addView(button("$name  ·  ${Uri.parse(base).host}") { server.url = base; showApp() })
                    found.getChildAt(0)?.requestFocus()
                }
            }.start()
        })
        col.addView(status)
        col.addView(found)
        root.removeAllViews()
        root.addView(ScrollView(this).apply { addView(col); isFillViewport = true })
        if (isTV) col.getChildAt(col.indexOfChild(input) + 2)?.requestFocus() else input.requestFocus()
    }

    // ---- the app ----------------------------------------------------------------------------------

    @Suppress("SetJavaScriptEnabled")
    private fun showApp() {
        val w = WebView(this)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.mediaPlaybackRequiresUserGesture = false
        w.settings.allowFileAccess = false
        w.settings.allowContentAccess = false
        w.setBackgroundColor(Color.rgb(11, 11, 16))
        CookieManager.getInstance().setAcceptCookie(true)
        w.addJavascriptInterface(Bridge(), "CellovisionApp")
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if ("${u.scheme}://${u.authority}" == server.url) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showSetup("Couldn't reach ${server.url} (${error.description}).")
            }
        }
        web = w
        root.removeAllViews()
        root.addView(w, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        w.loadUrl(server.url)
        w.requestFocus(View.FOCUS_DOWN)
    }

    /** What the server's pages can ask of this app. */
    inner class Bridge {
        @JavascriptInterface fun isTV(): Boolean = isTV
        /** Plays an item in the native player. start < 0: where they left off. */
        @JavascriptInterface fun play(id: String, start: Double, queue: String?) {
            CookieManager.getInstance().flush()
            startActivity(Intent(this@MainActivity, PlayerActivity::class.java).putExtra("id", id).putExtra("start", start).putExtra("queue", queue ?: ""))
        }
        @JavascriptInterface fun changeServer() { runOnUiThread { server.url = ""; showSetup(null) } }
        @JavascriptInterface fun themeChanged(mode: String) { /* the app's own screens are always dark */ }
    }

    override fun onResume() {
        super.onResume()
        // Back from the player: the page refreshes its Keep Watching and watched marks.
        web?.evaluateJavascript("window.dispatchEvent(new Event('cv-player-closed'))", null)
    }

    @Deprecated("Back goes back in the app first")
    override fun onBackPressed() {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // TV remotes: Menu opens the page's menu (the profile button).
        if (event.keyCode == KeyEvent.KEYCODE_MENU && event.action == KeyEvent.ACTION_UP) { web?.evaluateJavascript("document.querySelector('.avatar')?.click()", null); return true }
        return super.dispatchKeyEvent(event)
    }
}
