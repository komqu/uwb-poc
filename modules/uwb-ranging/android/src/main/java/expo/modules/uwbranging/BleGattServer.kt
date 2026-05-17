package expo.modules.uwbranging

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * Minimal BLE GATT server used as the UWB out-of-band channel.
 *
 *  - The CONTROLLER side runs this server.
 *  - It advertises a single service `serviceUuid` with the pairing code
 *    embedded as the device's local name so the controlee can pick the
 *    correct phone out of any other UWB-PoC instances nearby.
 *  - Exposes ONE characteristic (`characteristicUuid`) that is
 *    `WRITE | READ | NOTIFY`.
 *  - Flow:
 *       controlee --(WRITE)--> {"addr":"AABBCCDDEEFF1122"}
 *       controller -(NOTIFY)-> {"addr":..., "sk":..., "ch":..., "preamble":...,"sid":...}
 *
 * The payload is plain UTF-8 JSON — keeping it human-readable is more
 * useful than saving 30 bytes in a PoC.
 */
@SuppressLint("MissingPermission") // permission gating is the caller's job
internal class BleGattServer(
    private val context: Context,
    private val serviceUuid: UUID,
    private val characteristicUuid: UUID,
) {
    interface Listener {
        /** A controlee just wrote its UWB address + (optional) handshake nonce. */
        fun onControleeAddressReceived(controleeAddressHex: String)
        fun onAdvertiseError(code: Int)
    }

    companion object {
        private const val TAG = "UwbPoC-Gatt"
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private val btManager: BluetoothManager =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var characteristic: BluetoothGattCharacteristic? = null
    private var connectedDevice: BluetoothDevice? = null
    private var cccdEnabled: Boolean = false

    // Payload queued while waiting for the controlee to enable notifications.
    private var pendingNotifyPayload: String? = null

    var listener: Listener? = null

    /** Pairing code is encoded into the BLE advertising local name. */
    fun start(pairingCode: String) {
        check(gattServer == null) { "GATT server already running" }

        val char = BluetoothGattCharacteristic(
            characteristicUuid,
            BluetoothGattCharacteristic.PROPERTY_READ
                or BluetoothGattCharacteristic.PROPERTY_WRITE
                or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ
                or BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        char.addDescriptor(
            BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ
                    or BluetoothGattDescriptor.PERMISSION_WRITE,
            )
        )
        characteristic = char

        val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(char)

        gattServer = btManager.openGattServer(context, serverCallback).also {
            it.addService(service)
        }

        // ----------- Advertise ------------
        advertiser = btManager.adapter?.bluetoothLeAdvertiser
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()

        // The device's "local name" is the BLE name visible to scanners.
        // Putting the pairing code there makes filtering on the controlee
        // side trivial. (Manufacturer-data would be cleaner but heavier.)
        runCatching { btManager.adapter?.setName("UWB-$pairingCode") }

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(true)
            .addServiceUuid(ParcelUuid(serviceUuid))
            .build()

        advertiser?.startAdvertising(settings, data, advertiseCallback)
            ?: Log.w(TAG, "No BLE advertiser available")
    }

    /**
     * Send the OOB session params payload back to the controlee that
     * just wrote its address. Triggered by the module after it has
     * created its UWB controller session and knows complexChannel.
     */
    fun notifySessionParams(payload: String) {
        val char = characteristic ?: return
        val device = connectedDevice ?: return
        if (!cccdEnabled) {
            // Controlee hasn't subscribed yet — queue and send once CCCD arrives.
            Log.d(TAG, "CCCD not yet enabled, queuing notification")
            pendingNotifyPayload = payload
            return
        }
        sendNotification(device, char, payload)
    }

    private fun sendNotification(device: BluetoothDevice, char: BluetoothGattCharacteristic, payload: String) {
        val bytes = payload.toByteArray(Charsets.UTF_8)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gattServer?.notifyCharacteristicChanged(device, char, false, bytes)
        } else {
            @Suppress("DEPRECATION")
            char.value = bytes
            @Suppress("DEPRECATION")
            gattServer?.notifyCharacteristicChanged(device, char, false)
        }
        Log.d(TAG, "Notification sent (${bytes.size} bytes)")
    }

    fun stop() {
        runCatching { advertiser?.stopAdvertising(advertiseCallback) }
        runCatching { gattServer?.close() }
        gattServer = null
        advertiser = null
        characteristic = null
        connectedDevice = null
        cccdEnabled = false
        pendingNotifyPayload = null
    }

    // -------------- Callbacks ----------------

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            Log.e(TAG, "BLE advertise failed: $errorCode")
            listener?.onAdvertiseError(errorCode)
        }
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            Log.d(TAG, "GATT connection state: device=${device.address} status=$status newState=$newState")
            if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                connectedDevice = device
            } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                if (connectedDevice?.address == device.address) connectedDevice = null
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            val payload = value.toString(Charsets.UTF_8)
            Log.d(TAG, "Controlee wrote: $payload")

            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }

            // Best-effort parse of {"addr":"…"} – keep it forgiving.
            val addrHex = Regex("\"addr\"\\s*:\\s*\"([0-9A-Fa-f]+)\"")
                .find(payload)?.groupValues?.getOrNull(1)
            if (addrHex != null) {
                listener?.onControleeAddressReceived(addrHex.uppercase())
            } else {
                Log.w(TAG, "Could not parse controlee address from $payload")
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            // The controlee enabling notifications on the CCCD.
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
            val enabling = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            cccdEnabled = enabling
            Log.d(TAG, "CCCD ${if (enabling) "enabled" else "disabled"} by ${device.address}")

            // If the controller already called notifySessionParams before the
            // CCCD was set up, send the queued payload now.
            if (enabling) {
                val queued = pendingNotifyPayload ?: return
                pendingNotifyPayload = null
                val char = characteristic ?: return
                sendNotification(device, char, queued)
            }
        }
    }
}
