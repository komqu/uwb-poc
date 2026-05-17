package expo.modules.uwbranging

import android.os.Build
import android.util.Log
import androidx.core.uwb.RangingMeasurement
import androidx.core.uwb.RangingParameters
import androidx.core.uwb.RangingResult
import androidx.core.uwb.UwbAddress
import androidx.core.uwb.UwbComplexChannel
import androidx.core.uwb.UwbControleeSessionScope
import androidx.core.uwb.UwbControllerSessionScope
import androidx.core.uwb.UwbDevice
import androidx.core.uwb.UwbManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.UUID

/**
 * Expo native module exposing the Android Jetpack UWB API + a BLE GATT
 * out-of-band handshake.
 *
 * NOTE on `androidx.core.uwb:1.0.0-alpha08`
 * ----------------------------------------
 * The Jetpack UWB library is still in alpha and the API changes between
 * releases. The signatures used here target alpha-08. If you bump the
 * dep, check the migration notes section of the README.
 */
class UwbRangingModule : Module() {

    companion object {
        private const val TAG = "UwbPoC-Module"
        private const val EV_RESULT = "onRangingResult"
        private const val EV_ERROR = "onRangingError"
        private const val EV_LOST = "onPeerLost"

        // Public role constants surfaced as JS constants on the module.
        const val ROLE_CONTROLLER = "CONTROLLER"
        const val ROLE_CONTROLEE = "CONTROLEE"

        // The Jetpack UWB pairwise config used by this PoC. UNICAST_DS_TWR
        // means single peer, double-sided two-way ranging — the standard
        // option for an Android-to-Android session.
        private const val UWB_CONFIG_TYPE = RangingParameters.CONFIG_UNICAST_DS_TWR
    }

    // ---- State ----------------------------------------------------------------------------

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var rangingJob: Job? = null

    // The controller session scope is opened in `prepareControllerSession` so
    // we can read the OS-chosen `uwbComplexChannel` and ship it to the
    // controlee via OOB. It is reused in `startRangingInternal`.
    @Volatile private var preparedController: UwbControllerSessionScope? = null

    private var gattServer: BleGattServer? = null

    // ---- Module definition ----------------------------------------------------------------

    override fun definition() = ModuleDefinition {
        Name("UwbRanging")

        Constants(
            "ROLE_CONTROLLER" to ROLE_CONTROLLER,
            "ROLE_CONTROLEE" to ROLE_CONTROLEE,
        )

        Events(EV_RESULT, EV_ERROR, EV_LOST)

        AsyncFunction("isUwbSupported") {
            isUwbSupportedSync()
        }

        AsyncFunction("getLocalAddress") {
            getLocalAddressSync()
        }

        AsyncFunction("startGattAdvertising") { pairingCode: String, serviceUuid: String, characteristicUuid: String ->
            startGattAdvertising(pairingCode, serviceUuid, characteristicUuid)
        }

        AsyncFunction("stopGattAdvertising") {
            stopGattAdvertising()
        }

        /**
         * Open the controller session scope so the OS picks a complex
         * channel + preamble. Returns those + the controller's UWB
         * address as a map, ready to be shipped via OOB. The opened
         * scope is cached for the subsequent `startRanging` call.
         */
        AsyncFunction("prepareControllerSession") {
            prepareControllerSession()
        }

        AsyncFunction("notifyOobPayload") { payloadJson: String ->
            gattServer?.notifySessionParams(payloadJson)
                ?: throw CodedException("ERR_GATT_NOT_RUNNING", "GATT server not running", null)
        }

        AsyncFunction("startRanging") { role: String, peerAddressHex: String, sessionKeyHex: String, complexChannelChannel: Int, complexChannelPreamble: Int, sessionId: Int ->
            startRangingInternal(role, peerAddressHex, sessionKeyHex, complexChannelChannel, complexChannelPreamble, sessionId)
        }

        AsyncFunction("stopRanging") {
            stopRangingInternal()
        }

        OnDestroy {
            stopRangingInternal()
            stopGattAdvertising()
            scope.cancel()
        }
    }

    // ---- isUwbSupported -------------------------------------------------------------------

    private fun isUwbSupportedSync(): Boolean {
        val ctx = appContext.reactContext ?: return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        if (!ctx.packageManager.hasSystemFeature("android.hardware.uwb")) return false
        return try {
            UwbManager.createInstance(ctx)
            // `isAvailable()` is the canonical check in newer alphas. On
            // alpha-08 we have to fall back to attempting a manager
            // creation, but PackageManager.FEATURE_UWB is a strong first
            // signal so we return true here and let `startRanging`
            // surface any deeper failure.
            true
        } catch (t: Throwable) {
            Log.w(TAG, "isUwbSupported probe failed: ${t.message}")
            false
        }
    }

    // ---- getLocalAddress ------------------------------------------------------------------

    private fun getLocalAddressSync(): String {
        val ctx = appContext.reactContext
            ?: throw CodedException("ERR_NO_CONTEXT", "React context unavailable", null)
        val mgr = UwbManager.createInstance(ctx)

        // The local UWB address is bound to a session scope. We open a
        // throwaway controlee scope just for the address read; the real
        // ranging session opens its own scope later.
        return runBlocking {
            val s: UwbControleeSessionScope = mgr.controleeSessionScope()
            val addr: UwbAddress = s.localAddress
            HexUtil.bytesToHex(addr.address)
        }
    }

    // ---- BLE GATT advertising -------------------------------------------------------------

    private fun startGattAdvertising(pairingCode: String, serviceUuid: String, characteristicUuid: String) {
        val ctx = appContext.reactContext
            ?: throw CodedException("ERR_NO_CONTEXT", "React context unavailable", null)
        if (gattServer != null) return

        val server = BleGattServer(
            context = ctx,
            serviceUuid = UUID.fromString(serviceUuid),
            characteristicUuid = UUID.fromString(characteristicUuid),
        )
        server.listener = object : BleGattServer.Listener {
            override fun onControleeAddressReceived(controleeAddressHex: String) {
                // Synthetic event piggy-backed on the error channel so
                // the JS side can react and ship the OOB response. Code
                // prefix `INFO_` makes the intent obvious in logs.
                sendEvent(EV_ERROR, mapOf(
                    "code" to "INFO_CONTROLEE_ADDR",
                    "message" to controleeAddressHex,
                ))
            }
            override fun onAdvertiseError(code: Int) {
                sendEvent(EV_ERROR, mapOf(
                    "code" to "ERR_BLE_ADVERTISE",
                    "message" to "BLE advertise failed (code=$code)",
                ))
            }
        }
        server.start(pairingCode)
        gattServer = server
    }

    private fun stopGattAdvertising() {
        gattServer?.stop()
        gattServer = null
    }

    // ---- Controller pre-flight ------------------------------------------------------------

    private fun prepareControllerSession(): Map<String, Any> {
        val ctx = appContext.reactContext
            ?: throw CodedException("ERR_NO_CONTEXT", "React context unavailable", null)
        val mgr = UwbManager.createInstance(ctx)
        return runBlocking {
            val s: UwbControllerSessionScope = mgr.controllerSessionScope()
            preparedController = s
            val ch: UwbComplexChannel = s.uwbComplexChannel
            mapOf(
                "address" to HexUtil.bytesToHex(s.localAddress.address),
                "channel" to ch.channel,
                "preamble" to ch.preambleIndex,
            )
        }
    }

    // ---- Ranging --------------------------------------------------------------------------

    private fun startRangingInternal(
        role: String,
        peerAddressHex: String,
        sessionKeyHex: String,
        complexChannelChannel: Int,
        complexChannelPreamble: Int,
        sessionId: Int,
    ) {
        val ctx = appContext.reactContext
            ?: throw CodedException("ERR_NO_CONTEXT", "React context unavailable", null)

        // Cancel any in-flight ranging flow but keep `preparedController`
        // so the controller path can reuse the scope it just opened.
        rangingJob?.cancel()
        rangingJob = null

        val sessionKey = HexUtil.hexToBytes(sessionKeyHex)
        val peerBytes = HexUtil.hexToBytes(peerAddressHex)
        val peerDevice = UwbDevice(UwbAddress(peerBytes))

        rangingJob = scope.launch {
            try {
                val mgr = UwbManager.createInstance(ctx)

                val resultFlow = when (role) {
                    ROLE_CONTROLLER -> {
                        val s: UwbControllerSessionScope =
                            preparedController ?: mgr.controllerSessionScope().also {
                                preparedController = it
                            }
                        val complex = s.uwbComplexChannel
                        val params = RangingParameters(
                            uwbConfigType = UWB_CONFIG_TYPE,
                            sessionId = sessionId,
                            subSessionId = 0,
                            sessionKeyInfo = sessionKey,
                            subSessionKeyInfo = null,
                            complexChannel = complex,
                            peerDevices = listOf(peerDevice),
                            updateRateType = RangingParameters.RANGING_UPDATE_RATE_FREQUENT,
                        )
                        s.prepareSession(params)
                    }

                    ROLE_CONTROLEE -> {
                        val s = mgr.controleeSessionScope()
                        val complex = UwbComplexChannel(
                            channel = complexChannelChannel,
                            preambleIndex = complexChannelPreamble,
                        )
                        val params = RangingParameters(
                            uwbConfigType = UWB_CONFIG_TYPE,
                            sessionId = sessionId,
                            subSessionId = 0,
                            sessionKeyInfo = sessionKey,
                            subSessionKeyInfo = null,
                            complexChannel = complex,
                            peerDevices = listOf(peerDevice),
                            updateRateType = RangingParameters.RANGING_UPDATE_RATE_FREQUENT,
                        )
                        s.prepareSession(params)
                    }

                    else -> throw CodedException("ERR_BAD_ROLE", "Unknown role: $role", null)
                }

                resultFlow
                    .catch { t ->
                        Log.e(TAG, "Ranging flow error", t)
                        sendEvent(EV_ERROR, mapOf(
                            "code" to "ERR_RANGING_FLOW",
                            "message" to (t.message ?: "Unknown ranging error"),
                        ))
                    }
                    .collect { result -> dispatchRangingResult(result) }

            } catch (t: Throwable) {
                Log.e(TAG, "startRanging failed", t)
                sendEvent(EV_ERROR, mapOf(
                    "code" to "ERR_RANGING_START",
                    "message" to (t.message ?: "Failed to start UWB session"),
                ))
            }
        }
    }

    private fun dispatchRangingResult(result: RangingResult) {
        when (result) {
            is RangingResult.RangingResultPosition -> {
                val pos = result.position
                val distance = pos.distance.toSafeDouble()
                val azimuth = pos.azimuth.toSafeDouble()
                val elevation = pos.elevation.toSafeDouble()

                if (distance == null) {
                    // No distance measurement in this report; skip.
                    return
                }

                sendEvent(EV_RESULT, mapOf(
                    "distance" to distance,
                    "azimuthDegrees" to (azimuth ?: 0.0),
                    "elevationDegrees" to (elevation ?: 0.0),
                ))
            }
            is RangingResult.RangingResultPeerDisconnected -> {
                sendEvent(EV_LOST, emptyMap<String, Any>())
            }
            else -> {
                Log.d(TAG, "Unhandled RangingResult subtype: ${result.javaClass.simpleName}")
            }
        }
    }

    private fun stopRangingInternal() {
        rangingJob?.cancel()
        rangingJob = null
        preparedController = null
    }

    // ---- Helpers --------------------------------------------------------------------------

    /** `value` is meters for distance and degrees for azimuth/elevation. */
    private fun RangingMeasurement?.toSafeDouble(): Double? {
        if (this == null) return null
        return try {
            value.toDouble()
        } catch (_: Throwable) {
            null
        }
    }
}
