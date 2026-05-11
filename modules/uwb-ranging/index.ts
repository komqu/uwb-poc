/**
 * JS/TS surface for the native `UwbRanging` Expo module.
 *
 * The native module (Kotlin) exposes a thin set of imperative methods.
 * Anything more complex (state machine, BLE scanning from JS, retry
 * logic) lives in `hooks/useUwbRanging.ts`.
 */

import { NativeModule, requireNativeModule } from 'expo-modules-core';
import type { DeviceRole, RangingResult, UwbError } from '../../types/uwb';

type Events = {
  onRangingResult: (e: RangingResult) => void;
  onRangingError: (e: UwbError) => void;
  onPeerLost: () => void;
};

declare class UwbRangingNativeModule extends NativeModule<Events> {
  readonly ROLE_CONTROLLER: 'CONTROLLER';
  readonly ROLE_CONTROLEE: 'CONTROLEE';

  isUwbSupported(): Promise<boolean>;
  getLocalAddress(): Promise<string>;

  startGattAdvertising(
    pairingCode: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<void>;
  stopGattAdvertising(): Promise<void>;

  /**
   * Open the controller-side UWB session scope, read the OS-chosen
   * complex channel + preamble, and return them with the local address.
   * Must be called before `startRanging("CONTROLLER", ...)` so the
   * controlee can be told which channel to listen on via OOB.
   */
  prepareControllerSession(): Promise<{
    address: string;
    channel: number;
    preamble: number;
  }>;

  /** Send the controller-side OOB payload (UTF-8 JSON) to the connected controlee. */
  notifyOobPayload(payloadJson: string): Promise<void>;

  startRanging(
    role: DeviceRole,
    peerAddressHex: string,
    sessionKeyHex: string,
    complexChannelChannel: number,
    complexChannelPreamble: number,
    sessionId: number,
  ): Promise<void>;

  stopRanging(): Promise<void>;
}

const UwbRanging = requireNativeModule<UwbRangingNativeModule>('UwbRanging');

export default UwbRanging;
export type { DeviceRole, RangingResult, UwbError } from '../../types/uwb';
