# UWB Ranging PoC (Android · Expo · Jetpack UWB)

Two Android phones, one screen each, paired over BLE, ranging over
Ultra-Wideband. Built on Expo Bare + a custom native module that wraps
`androidx.core.uwb`.

## What this PoC does

1. Discover a peer over Bluetooth LE — used only as the UWB
   **out-of-band (OOB)** channel.
2. Exchange UWB session parameters (addresses, session key, complex
   channel, session id) over a single GATT characteristic.
3. Open a UWB ranging session via `androidx.core.uwb`.
4. Display live **distance**, **azimuth**, **elevation** at the
   `RANGING_UPDATE_RATE_FREQUENT` cadence.

No backend, no auth, no map. Just two phones pointing at each other.

## Required hardware

UWB on Android requires both an Ultra-Wideband radio in the SoC and
Android 13 (API 33) or later. Tested‑on / recommended devices:

| Vendor   | Model                              | UWB | Android |
|----------|------------------------------------|-----|---------|
| Google   | Pixel 6 Pro / 7 Pro / 8 / 8 Pro    | yes | 13+     |
| Samsung  | Galaxy S22+ / S22 Ultra / S23 / S24| yes | 13+     |
| Samsung  | Fold 3 / Fold 4 / Fold 5           | yes | 13+     |
| Xiaomi   | Mix 4                              | yes | 12 (no) |

The base Pixel 6 and Pixel 7 do **not** have UWB. A canonical list lives
at <https://source.android.com/docs/core/connect/uwb>.

You need **two** UWB devices to test ranging.

## Project layout

```
app/
  _layout.tsx               expo-router root layout
  index.tsx                 single PoC screen
hooks/
  useUwbRanging.ts          React hook + BLE client + state machine
modules/
  uwb-ranging/
    package.json            local module manifest
    expo-module.config.json registers UwbRangingModule on Android
    index.ts                JS surface for the native module
    android/
      build.gradle          androidx.core.uwb deps + Kotlin config
      src/main/
        AndroidManifest.xml UWB + BLE permissions
        java/expo/modules/uwbranging/
          UwbRangingModule.kt   ← main module
          BleGattServer.kt      ← controller-side GATT server
          UwbRangingPackage.kt  ← marker (modern Expo doesn't need it)
          HexUtil.kt            ← hex <-> bytes helpers
types/
  uwb.ts                    DeviceRole, RangingResult, UwbError, OobPayload
app.json                    Expo config (minSdk 33, plugin, extras)
.env.example                BLE service/characteristic UUIDs + timeout
```

## Build & install

```bash
# 1. Install JS deps
npm install   # or yarn / pnpm

# 2. Generate the native android/ folder (because we're Bare workflow).
npx expo prebuild --platform android --clean

# 3. Sideload to a UWB-capable phone.
npx expo run:android --device
```

Repeat step 3 with the second phone connected (or just install the same
APK on both).

## Pairing flow — for testers

1. Launch the app on **both** phones.
2. On phone A tap **"Act as CONTROLLER"**. A 6-character pairing code
   appears (e.g. `Q7HBKM`). Status shows _Waiting for peer_.
3. On phone B tap **"Act as CONTROLEE"**, type the code, tap
   **Connect**. The phone scans for the BLE advertisement carrying the
   matching local name (`UWB-Q7HBKM`).
4. As soon as the GATT write/notify completes, both phones flip into
   the **RANGING ACTIVE** screen and you should see live numbers
   (~10 Hz).
5. Wave the phones around — the proximity dot scales with distance
   (green < 1 m → yellow 1–3 m → red > 3 m).
6. Either side can tap **Stop** to tear down BLE + UWB cleanly.

## Permissions you'll be prompted for

- `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE` — all
  needed for the GATT handshake on Android 12+.
- `ACCESS_FINE_LOCATION` — some OEMs still gate BLE scan results behind
  it; harmless if denied but you'll see no scan callbacks.
- `UWB_RANGING` — required to open a UWB session.

A deny on any of these surfaces an `ERR_PERMISSION_DENIED` and a Retry
button on screen.

## Known limitations of the Jetpack UWB alpha API

The PoC depends on:

```
androidx.core.uwb:uwb:1.0.0-alpha08
androidx.core.uwb:uwb-rxjava3:1.0.0-alpha08
```

This library is still alpha. Compatibility caveats worth knowing:

- **API churn between alphas.** `RangingParameters`, `UwbComplexChannel`
  and the session-scope methods changed signatures several times. The
  module here targets the alpha-08 layout:
  `RangingParameters(uwbConfigType, sessionId, subSessionId,
  sessionKeyInfo, subSessionKeyInfo, complexChannel, peerDevices,
  updateRateType)`. If you bump to alpha-09+ check the
  `androidx.core.uwb` release notes — the field ordering / required
  args have been known to move.
- **Update-rate constants.** `RANGING_UPDATE_RATE_FREQUENT`,
  `RANGING_UPDATE_RATE_NORMAL`, `RANGING_UPDATE_RATE_INFREQUENT`. Some
  alphas substitute `RANGING_UPDATE_RATE_AUTOMATIC`.
- **`isAvailable()`.** Alpha-08 exposes session-scope creation but not
  a reliable `UwbManager.isAvailable()` async API. The PoC therefore
  falls back to `PackageManager.FEATURE_UWB` for the support probe and
  surfaces deeper errors only when a session is actually started.
- **Local address vs session scope.** The local UWB address only
  exists once you've opened a `controllerSessionScope` or
  `controleeSessionScope`. The module opens a throwaway controlee
  scope to read it; this is cheap but means the very first
  `getLocalAddress()` call can take a few ms.
- **Result subtypes.** `RangingResult.RangingResultPosition` and
  `RangingResult.RangingResultPeerDisconnected` are the only two
  shipped. Future alphas may add more.
- **Single peer.** This PoC hard-codes one peer per session
  (`CONFIG_UNICAST_DS_TWR`). Multi-peer needs `CONFIG_MULTICAST_DS_TWR`
  and a different OOB schema.
- **Azimuth/elevation availability.** Devices vary in how many UWB
  antennas they ship with. A phone without AoA hardware will report
  `0.0` for azimuth/elevation. Distance is always provided.

## Architecture notes

- **GATT server in Kotlin, GATT client in JS.** The controller-side
  GATT server is in `BleGattServer.kt` because Android's GATT-server
  APIs are awkward to drive over the bridge. The controlee side uses
  `react-native-ble-plx` from JS because the client API is simple
  enough to live there cleanly.
- **OOB payload is JSON.** Plain UTF-8 over a single characteristic.
  In a non-PoC you'd swap this for a CBOR or fixed-binary layout and
  add encryption.
- **Error channel overloads.** To keep the event surface small, the
  native module emits the controlee-address callback through the
  `onRangingError` event with `code: "INFO_CONTROLEE_ADDR"`. The hook
  separates the two cleanly.
- **No backend.** The session key is a 128-bit random number generated
  on the controller and shipped to the controlee over BLE. Adequate
  for a PoC; in production you'd derive it from a shared secret
  established out-of-band beforehand.

## Troubleshooting

- _"BLE advertise failed (code=N)"_: usually means BLUETOOTH_ADVERTISE
  is missing or the device's advertising slot is exhausted. Reboot the
  phone or kill other BLE-advertising apps.
- _Controlee can't find controller_: the controller's BLE local name
  must be set to `UWB-<pairingCode>`. Some launchers reset device name
  on power cycle; restart the controller side first if a previous
  session failed.
- _Distance jumps around / NaN_: check both phones are held in
  free space (UWB likes line-of-sight) and that no metallic case is
  blocking the UWB antenna near the top edge.

## License

PoC code, MIT-style — do whatever you want.
