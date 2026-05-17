/**
 * useUwbRanging — single React hook owning the whole UWB+BLE state machine
 * for the PoC. Both roles share this hook; the only difference is which
 * starter the UI calls (`startAsController` vs `startAsControlee`).
 *
 * The hook delegates to:
 *   - native module `UwbRanging`            (GATT server + UWB session)
 *   - react-native-ble-plx                   (BLE scan + central role on controlee)
 *
 * Status transitions
 * ------------------
 *   idle ──startAsController──▶ advertising ──(controlee writes)──▶ ranging
 *   idle ──startAsControlee ──▶ scanning ──connecting ──▶ ranging
 *   any  ──stop / error      ──▶ idle / error
 */

import Constants from 'expo-constants';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State as BleState } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

import UwbRanging from '../modules/uwb-ranging';
import type {
  OobControleePayload,
  OobControllerPayload,
  RangingResult,
  UwbError,
  UwbStatus,
} from '../types/uwb';

// -------------------- Config -----------------------------------------------------

const SERVICE_UUID: string =
  (Constants.expoConfig?.extra?.uwbServiceUuid as string | undefined) ??
  '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHARACTERISTIC_UUID: string =
  (Constants.expoConfig?.extra?.uwbCharacteristicUuid as string | undefined) ??
  '0000ffe1-0000-1000-8000-00805f9b34fb';
const PAIRING_TIMEOUT_MS = 30_000;

// A single shared BleManager instance is fine for a PoC.
let bleManagerSingleton: BleManager | null = null;
function getBleManager(): BleManager {
  if (!bleManagerSingleton) bleManagerSingleton = new BleManager();
  return bleManagerSingleton;
}

// -------------------- Helpers ---------------------------------------------------

function makePairingCode(): string {
  // 6 chars, A-Z 0-9, no O/0/1/I to avoid mis-reads.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function makeSessionKeyHex(): string {
  // 8-byte (64-bit) random session key, hex-encoded.
  // CONFIG_UNICAST_DS_TWR with Static STS requires exactly 8 bytes.
  const bytes = new Uint8Array(8);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function makeSessionId(): number {
  // 32-bit non-zero session id.
  return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
}

function base64Encode(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}
function base64Decode(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf-8');
}

async function ensureBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const perms = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ];
  const granted = await PermissionsAndroid.requestMultiple(perms);
  return Object.values(granted).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

// -------------------- Hook ------------------------------------------------------

export interface UseUwbRanging {
  isSupported: boolean | null;
  localAddress: string | null;
  status: UwbStatus;
  result: RangingResult | null;
  error: UwbError | null;
  pairingCode: string | null;
  startAsController: () => Promise<void>;
  startAsControlee: (pairingCode: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function useUwbRanging(): UseUwbRanging {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [localAddress, setLocalAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<UwbStatus>('idle');
  const [result, setResult] = useState<RangingResult | null>(null);
  const [error, setError] = useState<UwbError | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  // Refs hold values that should not retrigger renders/listeners.
  const connectedDeviceRef = useRef<Device | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -------------------- Mount: probe support + local address --------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supported = await UwbRanging.isUwbSupported();
        if (cancelled) return;
        setIsSupported(supported);
        if (supported) {
          const addr = await UwbRanging.getLocalAddress();
          if (!cancelled) setLocalAddress(addr);
        }
      } catch (e: any) {
        if (!cancelled) {
          setIsSupported(false);
          setError({ code: 'ERR_NOT_SUPPORTED', message: e?.message ?? 'UWB unavailable' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------- Native event subscriptions ------------------------------
  useEffect(() => {
    const subResult = UwbRanging.addListener('onRangingResult', (e) => {
      setResult(e);
      setStatus('ranging');
    });
    const subError = UwbRanging.addListener('onRangingError', (e) => {
      // The native side overloads onRangingError with an INFO event for
      // the controller-side controlee-address callback. Handle that here.
      if (e.code === 'INFO_CONTROLEE_ADDR') {
        handleControleeAddressReceived(e.message).catch((err) => {
          setError({ code: 'ERR_UNKNOWN', message: err?.message ?? 'OOB exchange failed' });
          setStatus('error');
        });
        return;
      }
      setError(e);
      setStatus('error');
    });
    const subLost = UwbRanging.addListener('onPeerLost', () => {
      setError({ code: 'ERR_RANGING_FLOW', message: 'Peer disconnected' });
      setStatus('error');
    });

    return () => {
      subResult.remove();
      subError.remove();
      subLost.remove();
    };
    // We deliberately use a ref-style mutable closure inside the handler
    // for pending controller state — re-subscribing on every state change
    // would lose in-flight callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------- Controller side ----------------------------------------

  // Stash of pending controller params kept across the OOB callback.
  const pendingControllerRef = useRef<{
    sessionKeyHex: string;
    sessionId: number;
    address: string;
    channel: number;
    preamble: number;
  } | null>(null);

  const startAsController = useCallback(async () => {
    setError(null);
    setResult(null);

    if (!(await ensureBlePermissions())) {
      setError({ code: 'ERR_PERMISSION_DENIED', message: 'Bluetooth permissions denied' });
      setStatus('error');
      return;
    }

    const code = makePairingCode();
    const sessionKeyHex = makeSessionKeyHex();
    const sessionId = makeSessionId();

    // Open the controller UWB session scope NOW so we know the
    // OS-chosen complex channel & preamble before the controlee writes
    // its address — that way the OOB payload reflects reality.
    const prepared = await UwbRanging.prepareControllerSession();

    pendingControllerRef.current = {
      sessionKeyHex,
      sessionId,
      address: prepared.address,
      channel: prepared.channel,
      preamble: prepared.preamble,
    };
    setPairingCode(code);
    setStatus('advertising');

    await UwbRanging.startGattAdvertising(code, SERVICE_UUID, CHARACTERISTIC_UUID);
  }, []);

  /**
   * Triggered by the native module once the controlee has written its
   * UWB address to the GATT characteristic. We respond with the
   * controller's own address + session params, then start the UWB
   * ranging session locally using the scope opened in startAsController.
   */
  const handleControleeAddressReceived = useCallback(
    async (controleeAddrHex: string) => {
      const pending = pendingControllerRef.current;
      if (!pending) return;

      setStatus('connecting');

      const payload: OobControllerPayload = {
        addr: pending.address,
        sk: pending.sessionKeyHex,
        ch: pending.channel,
        preamble: pending.preamble,
        sid: pending.sessionId,
      };
      await UwbRanging.notifyOobPayload(JSON.stringify(payload));

      // Kick off the UWB ranging session.
      await UwbRanging.startRanging(
        'CONTROLLER',
        controleeAddrHex,
        pending.sessionKeyHex,
        pending.channel,
        pending.preamble,
        pending.sessionId,
      );
    },
    [],
  );

  // -------------------- Controlee side -----------------------------------------

  const startAsControlee = useCallback(async (codeInput: string) => {
    setError(null);
    setResult(null);

    if (!(await ensureBlePermissions())) {
      setError({ code: 'ERR_PERMISSION_DENIED', message: 'Bluetooth permissions denied' });
      setStatus('error');
      return;
    }

    const ble = getBleManager();
    setStatus('scanning');

    // Wait for the BLE adapter to be powered on.
    const state = await ble.state();
    if (state !== BleState.PoweredOn) {
      await new Promise<void>((resolve) => {
        const sub = ble.onStateChange((s) => {
          if (s === BleState.PoweredOn) {
            sub.remove();
            resolve();
          }
        }, true);
      });
    }

    const target = `UWB-${codeInput.trim().toUpperCase()}`;

    const found = await new Promise<Device | null>((resolve) => {
      scanTimeoutRef.current = setTimeout(() => {
        ble.stopDeviceScan();
        resolve(null);
      }, PAIRING_TIMEOUT_MS);

      ble.startDeviceScan([SERVICE_UUID], null, (err, device) => {
        if (err) {
          if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
          ble.stopDeviceScan();
          resolve(null);
          return;
        }
        if (device && (device.localName === target || device.name === target)) {
          if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
          ble.stopDeviceScan();
          resolve(device);
        }
      });
    });

    if (!found) {
      setError({ code: 'ERR_BLE_SCAN_TIMEOUT', message: 'No controller found with that pairing code' });
      setStatus('error');
      return;
    }

    setStatus('connecting');
    const connected = await found.connect();
    connectedDeviceRef.current = connected;
    await connected.discoverAllServicesAndCharacteristics();

    // 1. Subscribe to notifications BEFORE writing — otherwise we may
    //    miss the controller's reply.
    const notifyPromise = new Promise<OobControllerPayload>((resolve, reject) => {
      const sub = connected.monitorCharacteristicForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        (err, char) => {
          if (err) {
            sub.remove();
            reject(err);
            return;
          }
          if (!char?.value) return;
          try {
            const text = base64Decode(char.value);
            const parsed = JSON.parse(text) as OobControllerPayload;
            if (parsed?.addr) {
              sub.remove();
              resolve(parsed);
            }
          } catch (e) {
            sub.remove();
            reject(e);
          }
        },
      );

      // Timeout to avoid hanging forever if the controller dies.
      setTimeout(() => {
        sub.remove();
        reject(new Error('Timed out waiting for controller OOB response'));
      }, PAIRING_TIMEOUT_MS);
    });

    // 2. Write our UWB address.
    const myAddress = await UwbRanging.getLocalAddress();
    const writePayload: OobControleePayload = { addr: myAddress };
    await connected.writeCharacteristicWithResponseForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      base64Encode(JSON.stringify(writePayload)),
    );

    // 3. Wait for notify.
    const ctrl = await notifyPromise;

    // 4. Start ranging on the controlee side.
    await UwbRanging.startRanging(
      'CONTROLEE',
      ctrl.addr,
      ctrl.sk,
      ctrl.ch,
      ctrl.preamble,
      ctrl.sid,
    );
  }, []);

  // -------------------- Stop ---------------------------------------------------

  const stop = useCallback(async () => {
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    try { getBleManager().stopDeviceScan(); } catch {}
    try {
      const d = connectedDeviceRef.current;
      if (d) await d.cancelConnection();
    } catch {}
    connectedDeviceRef.current = null;

    try { await UwbRanging.stopRanging(); } catch {}
    try { await UwbRanging.stopGattAdvertising(); } catch {}

    pendingControllerRef.current = null;
    setStatus('idle');
    setResult(null);
    setPairingCode(null);
  }, []);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isSupported,
    localAddress,
    status,
    result,
    error,
    pairingCode,
    startAsController,
    startAsControlee,
    stop,
  };
}
