package com.cellovision.app

import android.app.Activity
import android.app.PictureInPictureParams
import android.media.MediaCodecList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.KeyEvent
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject

/**
 * Plays one item (then the next episode, or the rest of a queue) with Media3 ExoPlayer.
 * The server decides how (Fit to Device) from what this device's decoders can do; progress is
 * saved every few seconds so Keep Watching works across devices.
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {
    private lateinit var server: Server
    private lateinit var view: PlayerView
    private var player: ExoPlayer? = null
    private var itemId = ""
    private var item: JSONObject? = null
    private var plan: JSONObject? = null
    private var offset = 0.0           // a converted stream that started part-way in
    private var queue = listOf<String>()
    private val main = Handler(Looper.getMainLooper())
    private var reporting: Runnable? = null
    private var stopped = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = Server(this)
        Trust.install(this) // (the trusted server's certificate, for the player's own requests)
        view = PlayerView(this).apply {
            keepScreenOn = true
            setShowNextButton(false); setShowPreviousButton(false)
            controllerShowTimeoutMs = 3500
            setShowSubtitleButton(true)
        }
        setContentView(view)
        hideBars()
        queue = intent.getStringExtra("queue").orEmpty().split(",").filter { it.isNotBlank() }
        open(intent.getStringExtra("id") ?: return finish(), intent.getDoubleExtra("start", -1.0))
    }

    private fun hideBars() {
        if (Build.VERSION.SDK_INT >= 30) window.insetsController?.let { it.hide(WindowInsets.Type.systemBars()); it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE }
    }

    /** What this device can play itself (the server converts the rest). */
    private fun caps(): JSONObject {
        val types = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }.flatMap { it.supportedTypes.toList() }.map { it.lowercase() }.toSet()
        val video = JSONArray().apply { put("h264"); if ("video/hevc" in types) put("hevc"); if ("video/x-vnd.on2.vp9" in types) put("vp9"); if ("video/av01" in types) put("av1"); put("vp8"); put("mpeg4") }
        val audio = JSONArray().apply { listOf("aac", "mp3", "opus", "vorbis", "flac", "alac", "pcm_s16le").forEach { put(it) }; if ("audio/ac3" in types) put("ac3"); if ("audio/eac3" in types) put("eac3") }
        // ExoPlayer opens these boxes itself (Matroska included).
        val containers = JSONArray().apply { listOf("mp4", "mkv", "webm", "mp3", "m4a", "flac", "ogg", "wav").forEach { put(it) } }
        return JSONObject().put("video", video).put("audio", audio).put("containers", containers).put("maxHeight", JSONObject.NULL).put("hdr", display?.hdrCapabilities?.supportedHdrTypes?.isNotEmpty() == true)
    }

    private fun open(id: String, start: Double) {
        itemId = id
        stopReporting()
        Thread {
            try {
                val i = server.call("GET", "/api/item?id=${Uri.encode(id)}")
                val body = JSONObject().put("id", id).put("caps", caps())
                if (start >= 0) body.put("start", start).put("hlsStart", start)
                val p = server.call("POST", "/api/play", body.toString())
                runOnUiThread { item = i; plan = p; play(p) }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, e.message ?: "Couldn't play this", Toast.LENGTH_LONG).show(); finish() }
            }
        }.start()
    }

    private fun play(p: JSONObject) {
        val hls = p.optString("mode") != "direct"
        offset = if (hls) p.optDouble("start", 0.0) else 0.0
        val headers = mutableMapOf<String, String>()
        server.cookie()?.let { headers["cookie"] = it }
        val http = DefaultHttpDataSource.Factory().setDefaultRequestProperties(headers).setAllowCrossProtocolRedirects(true).setConnectTimeoutMs(10_000).setReadTimeoutMs(60_000)
        val exo = player ?: ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(http)).build().also { player = it; view.player = it; listen(it) }
        val url = server.url.trimEnd('/') + p.getString("url")
        val b = MediaItem.Builder().setUri(url)
        if (hls) b.setMimeType(MimeTypes.APPLICATION_M3U8)
        p.optString("subtitle").takeIf { it.isNotEmpty() && it != "null" }?.let {
            b.setSubtitleConfigurations(listOf(MediaItem.SubtitleConfiguration.Builder(Uri.parse(server.url.trimEnd('/') + it)).setMimeType(MimeTypes.TEXT_VTT).setSelectionFlags(C.SELECTION_FLAG_DEFAULT).build()))
        }
        exo.setMediaItem(b.build())
        exo.prepare()
        val resume = p.optDouble("resume", 0.0)
        if (!hls && resume > 0) exo.seekTo((resume * 1000).toLong())
        exo.playWhenReady = true
        startReporting()
    }

    private fun listen(exo: ExoPlayer) {
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) ended()
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { report() }
            override fun onPlayerError(error: PlaybackException) {
                val p = plan ?: return
                val title = item?.optString("title") ?: itemId
                Thread { server.report("playback failed", "$title: ${error.errorCodeName}", "mode ${p.optString("mode")}\n${error.message}\n${android.util.Log.getStackTraceString(error)}") }.start()
                // The device's decoder couldn't cope after all: ask the server to convert it.
                if (p.optString("mode") == "direct" || p.optString("mode") == "remux") {
                    Toast.makeText(this@PlayerActivity, "Converting this for your device…", Toast.LENGTH_SHORT).show()
                    Thread {
                        runCatching {
                            val body = JSONObject().put("id", itemId).put("caps", JSONObject().put("video", JSONArray().put("h264")).put("audio", JSONArray().put("aac")).put("containers", JSONArray().put("mp4")))
                                .put("start", position()).put("hlsStart", position()).put("force", "convert")
                            val np = server.call("POST", "/api/play", body.toString())
                            runOnUiThread { plan = np; play(np) }
                        }.onFailure { runOnUiThread { Toast.makeText(this@PlayerActivity, error.message, Toast.LENGTH_LONG).show(); finish() } }
                    }.start()
                } else { Toast.makeText(this@PlayerActivity, "Playback problem: ${error.errorCodeName}", Toast.LENGTH_LONG).show() }
            }
        })
    }

    private fun position(): Double = offset + (player?.currentPosition ?: 0) / 1000.0

    private fun report(extra: JSONObject.() -> Unit = {}) {
        val p = plan ?: return
        val body = JSONObject().put("id", itemId).put("position", position()).put("paused", player?.isPlaying != true).put("mode", p.optString("mode")).apply(extra).toString()
        Thread { runCatching { server.call("POST", "/api/playing", body) } }.start()
    }
    private fun startReporting() {
        stopReporting()
        reporting = object : Runnable { override fun run() { if (player?.isPlaying == true) report(); main.postDelayed(this, 10_000) } }.also { main.postDelayed(it, 10_000) }
    }
    private fun stopReporting() { reporting?.let { main.removeCallbacks(it) }; reporting = null }

    private fun ended() {
        val dur = item?.optDouble("duration", 0.0) ?: 0.0
        if (dur > 0 && dur - position() > 10 && plan?.optString("mode") != "direct") return // (a conversion ran out early: not the real end)
        report { put("position", dur) }
        val next = item?.optJSONObject("nextEpisode")?.optString("id")
        when {
            !next.isNullOrEmpty() -> { endSession(); open(next, 0.0) }
            queue.isNotEmpty() -> { endSession(); val n = queue.first(); queue = queue.drop(1); open(n, 0.0) }
            else -> finish()
        }
    }

    private fun endSession() {
        plan?.optString("session")?.takeIf { it.isNotEmpty() }?.let { s -> Thread { runCatching { server.call("DELETE", "/api/hls", JSONObject().put("session", s).toString()) } }.start() }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Phones: keep watching in a small window when leaving the app.
        if (Build.VERSION.SDK_INT >= 26 && player?.isPlaying == true && !packageManager.hasSystemFeature("android.software.leanback")) {
            runCatching { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build()) }
        }
    }
    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        view.useController = !isInPictureInPictureMode
    }

    override fun onStart() { super.onStart(); Updater.screenShown() }

    override fun onStop() {
        super.onStop()
        Updater.screenHidden(this)
        if (Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode) return
        player?.pause()
        if (isFinishing) release()
    }
    override fun onDestroy() { release(); super.onDestroy() }

    private fun release() {
        if (stopped) return
        stopped = true
        stopReporting()
        report { put("stopped", true) }
        endSession()
        player?.release(); player = null
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // TV remotes: OK shows the controls; media keys work straight away.
        if (event.action == KeyEvent.ACTION_DOWN && !view.isControllerFullyVisible && event.keyCode in setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER)) { view.showController(); return true }
        if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) { ended(); return true }
        return view.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) hideBars() }
}
