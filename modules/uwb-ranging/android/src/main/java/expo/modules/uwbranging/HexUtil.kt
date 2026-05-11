package expo.modules.uwbranging

/**
 * Small helpers for hex <-> ByteArray conversion. We use hex strings on
 * the JS bridge because react-native does not have a native ByteArray
 * type and base64 round-trips are clumsy to debug.
 */
internal object HexUtil {
    private val HEX_ARRAY = "0123456789ABCDEF".toCharArray()

    fun bytesToHex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            out[i * 2] = HEX_ARRAY[v ushr 4]
            out[i * 2 + 1] = HEX_ARRAY[v and 0x0F]
        }
        return String(out)
    }

    fun hexToBytes(hex: String): ByteArray {
        val s = hex.replace(":", "").replace(" ", "")
        require(s.length % 2 == 0) { "Hex string must have even length: $hex" }
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(s[i * 2], 16)
            val lo = Character.digit(s[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "Invalid hex string: $hex" }
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }
}
