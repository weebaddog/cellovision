package com.cellovision.app

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.Certificate
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * HTTPS to a Cellovision server. A server at home makes its own certificate (no public authority
 * can vouch for it), so the person trusts it once (checking its fingerprint) and from then on only
 * that exact certificate is accepted. Every other site (updates, the web) keeps Android's normal checks.
 */
object Trust {
    /** The fingerprint of the trusted server's certificate ("sha256/<base64>"), or "". */
    @Volatile var pinned = ""

    fun fingerprint(cert: Certificate): String =
        "sha256/" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(cert.encoded), Base64.NO_WRAP)

    private val system: X509TrustManager by lazy {
        val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        f.init(null as KeyStore?)
        f.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    private fun isPinned(chain: Array<out Certificate>?) = pinned.isNotEmpty() && !chain.isNullOrEmpty() && fingerprint(chain[0]) == pinned

    /** For every HTTPS connection the app makes (its own requests and the video player's). */
    fun install(context: Context) {
        pinned = context.getSharedPreferences("server", Context.MODE_PRIVATE).getString("fingerprint", "") ?: ""
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = system.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) { if (!isPinned(chain)) system.checkServerTrusted(chain, authType) }
            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
        }
        val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        HttpsURLConnection.setDefaultSSLSocketFactory(ctx.socketFactory)
        val hosts = HttpsURLConnection.getDefaultHostnameVerifier()
        HttpsURLConnection.setDefaultHostnameVerifier { host, session -> runCatching { isPinned(session.peerCertificates) }.getOrDefault(false) || hosts.verify(host, session) }
    }

    /**
     * The server's /api/hello over HTTPS, read without the certificate check, plus the fingerprint
     * of the certificate it answered with (for the person to compare). Null if nothing answered.
     */
    fun probe(base: String, timeoutMs: Int = 6000): Pair<JSONObject, String>? = runCatching {
        var seen: String? = null
        val open = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) { seen = chain?.firstOrNull()?.let { fingerprint(it) } }
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val c = URL(base.trimEnd('/') + "/api/hello").openConnection() as HttpsURLConnection
        c.sslSocketFactory = SSLContext.getInstance("TLS").apply { init(null, arrayOf(open), null) }.socketFactory
        c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true } // (only to read the fingerprint; nothing is sent)
        c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
        if (c.responseCode != 200) return null
        val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
        if (j.has("setUp") && j.has("profiles") && seen != null) j to seen!! else null
    }.getOrNull()
}
