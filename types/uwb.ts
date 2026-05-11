/**
 * Public types for the UWB ranging PoC.
 */

export type DeviceRole = 'CONTROLLER' | 'CONTROLEE';

export interface RangingResult {
  /** Distance to peer in meters. Negative or NaN values are filtered upstream. */
  distance: number;
  /** Bearing of peer relative to this device's antenna boresight, degrees. */
  azimuthDegrees: number;
  /** Vertical angle, degrees. May be 0 on devices without elevation AoA. */
  elevationDegrees: number;
}

export type UwbErrorCode =
  | 'ERR_NOT_SUPPORTED'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_BLE_ADVERTISE'
  | 'ERR_BLE_SCAN_TIMEOUT'
  | 'ERR_RANGING_START'
  | 'ERR_RANGING_FLOW'
  | 'ERR_BAD_ROLE'
  | 'ERR_GATT_NOT_RUNNING'
  | 'ERR_NO_CONTEXT'
  | 'ERR_UNKNOWN'
  // Informational events piggy-backed on the same channel:
  | 'INFO_CONTROLEE_ADDR';

export interface UwbError {
  code: UwbErrorCode;
  message: string;
}

export type UwbStatus =
  | 'idle'
  | 'advertising'   // controller waiting for controlee via BLE
  | 'scanning'      // controlee searching for the right BLE peer
  | 'connecting'    // BLE link established, OOB exchange in progress
  | 'ranging'       // UWB session live
  | 'error';

/**
 * The over-the-wire payload sent from controller -> controlee on the
 * BLE characteristic. Kept JSON for ease of debugging in the PoC.
 */
export interface OobControllerPayload {
  addr: string;       // controller UWB address (hex)
  sk: string;         // session key (hex, 16 or 32 bytes typical)
  ch: number;         // UWB complex channel (5 or 9)
  preamble: number;   // UWB preamble index
  sid: number;        // session id
}

export interface OobControleePayload {
  addr: string;       // controlee UWB address (hex)
}
