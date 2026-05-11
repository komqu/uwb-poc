/**
 * FestivalFinder UWB PoC — single screen.
 *
 * - Pick a role (CONTROLLER / CONTROLEE)
 * - Controller displays a 6-char pairing code on its screen
 * - Controlee enters the same code, the two devices pair via BLE,
 *   then start a UWB ranging session
 * - Live distance + azimuth + elevation update at ~10Hz
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useUwbRanging } from '../hooks/useUwbRanging';

type Role = 'CONTROLLER' | 'CONTROLEE' | null;

const COLOR_BG = '#0d0d0d';
const COLOR_TEXT = '#f5f5f5';
const COLOR_DIM = '#888';
const COLOR_PRIMARY = '#39ff14';
const COLOR_WARN = '#ffd23f';
const COLOR_DANGER = '#ff3b30';
const COLOR_BORDER = '#262626';

function colorForDistance(d: number): string {
  if (d < 1) return COLOR_PRIMARY;
  if (d < 3) return COLOR_WARN;
  return COLOR_DANGER;
}

export default function Screen() {
  const uwb = useUwbRanging();
  const [role, setRole] = useState<Role>(null);
  const [codeInput, setCodeInput] = useState('');

  // ----- Reanimated proximity dot --------------------------------------
  const scale = useSharedValue(0.2);

  useEffect(() => {
    if (uwb.result) {
      const d = Math.max(0, Math.min(5, uwb.result.distance));
      // 5 m -> scale 0.2 (far); 0 m -> scale 1.0 (close).
      const target = 1.0 - (d / 5) * 0.8;
      scale.value = withTiming(target, { duration: 250, easing: Easing.out(Easing.cubic) });
    }
  }, [uwb.result, scale]);

  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const dotColor = uwb.result ? colorForDistance(uwb.result.distance) : COLOR_DIM;

  // ----- Render guards -------------------------------------------------

  if (Platform.OS !== 'android') {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.title}>UWB PoC</Text>
        <Text style={styles.bodyDim}>
          This PoC is Android-only. Open it on a UWB-capable Android 13+
          device (Pixel 6 Pro / 7+ / 8, Galaxy S22+, etc.).
        </Text>
      </SafeAreaView>
    );
  }

  if (uwb.isSupported === false) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.title}>UWB not available</Text>
        <Text style={styles.bodyDim}>
          This device reports no Ultra-Wideband radio, or you're running
          below Android 13. Required: API 33 + and the
          `android.hardware.uwb` system feature.
        </Text>
        <Text style={styles.linkish}>
          See: https://source.android.com/docs/core/connect/uwb
        </Text>
      </SafeAreaView>
    );
  }

  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>FestivalFinder UWB PoC</Text>

      {uwb.localAddress && (
        <Text style={styles.bodyDim}>This device: {uwb.localAddress}</Text>
      )}

      {/* ----------- Role pick ----------- */}
      {role === null && uwb.status === 'idle' && (
        <View style={styles.col}>
          <PrimaryButton label="Act as CONTROLLER" onPress={() => {
            setRole('CONTROLLER');
            uwb.startAsController();
          }} />
          <View style={styles.spacer} />
          <PrimaryButton label="Act as CONTROLEE" onPress={() => setRole('CONTROLEE')} />
        </View>
      )}

      {/* ----------- Controller waiting screen ----------- */}
      {role === 'CONTROLLER' && uwb.status !== 'ranging' && uwb.status !== 'error' && (
        <View style={styles.col}>
          <Text style={styles.label}>Pairing Code</Text>
          <Text style={styles.pairingCode}>{uwb.pairingCode ?? '······'}</Text>
          <Text style={styles.bodyDim}>Status: {labelForStatus(uwb.status)}</Text>
        </View>
      )}

      {/* ----------- Controlee enter-code screen ----------- */}
      {role === 'CONTROLEE' && uwb.status === 'idle' && (
        <View style={styles.col}>
          <Text style={styles.label}>Enter pairing code shown on the other phone</Text>
          <TextInput
            value={codeInput}
            onChangeText={(t) => setCodeInput(t.toUpperCase())}
            placeholder="AB12XY"
            placeholderTextColor={COLOR_DIM}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={6}
            style={styles.input}
          />
          <View style={styles.spacer} />
          <PrimaryButton
            label="Connect"
            disabled={codeInput.trim().length !== 6}
            onPress={() => uwb.startAsControlee(codeInput.trim())}
          />
        </View>
      )}

      {role === 'CONTROLEE' && (uwb.status === 'scanning' || uwb.status === 'connecting') && (
        <Text style={styles.bodyDim}>Status: {labelForStatus(uwb.status)}…</Text>
      )}

      {/* ----------- Ranging readout ----------- */}
      {uwb.status === 'ranging' && uwb.result && (
        <View style={styles.col}>
          <Text style={styles.rangingHeader}>📡 RANGING ACTIVE</Text>

          <View style={styles.readoutRow}>
            <Text style={styles.readoutLabel}>Distance</Text>
            <Text style={styles.readoutValue}>{uwb.result.distance.toFixed(2)} m</Text>
          </View>
          <View style={styles.readoutRow}>
            <Text style={styles.readoutLabel}>Azimuth</Text>
            <Text style={styles.readoutValue}>{uwb.result.azimuthDegrees.toFixed(1)} °</Text>
          </View>
          <View style={styles.readoutRow}>
            <Text style={styles.readoutLabel}>Elevation</Text>
            <Text style={styles.readoutValue}>{uwb.result.elevationDegrees.toFixed(1)} °</Text>
          </View>

          <View style={styles.dotWrapper}>
            <Animated.View style={[styles.dot, { backgroundColor: dotColor }, dotStyle]} />
          </View>
        </View>
      )}

      {/* ----------- Errors ----------- */}
      {uwb.status === 'error' && uwb.error && (
        <View style={styles.col}>
          <Text style={[styles.title, { color: COLOR_DANGER }]}>Error</Text>
          <Text style={styles.bodyDim}>{uwb.error.code}</Text>
          <Text style={styles.body}>{uwb.error.message}</Text>
          <View style={styles.spacer} />
          <PrimaryButton
            label="Retry"
            onPress={() => {
              uwb.stop();
              setRole(null);
              setCodeInput('');
            }}
          />
        </View>
      )}

      {/* ----------- Stop / reset ----------- */}
      {(uwb.status !== 'idle' && uwb.status !== 'error') && (
        <View style={styles.bottom}>
          <SecondaryButton
            label="Stop"
            onPress={() => {
              uwb.stop();
              setRole(null);
              setCodeInput('');
            }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

// -------------------- Small UI bits ------------------------------------------

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[
        styles.btn,
        styles.btnPrimary,
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.btn, styles.btnSecondary]}>
      <Text style={[styles.btnText, { color: COLOR_TEXT }]}>{label}</Text>
    </Pressable>
  );
}

function labelForStatus(s: string): string {
  switch (s) {
    case 'idle':       return 'Idle';
    case 'advertising':return 'Waiting for peer';
    case 'scanning':   return 'Scanning for controller';
    case 'connecting': return 'Connecting';
    case 'ranging':    return 'Ranging';
    case 'error':      return 'Error';
    default:           return s;
  }
}

// -------------------- Styles -------------------------------------------------

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLOR_BG,
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  title: {
    color: COLOR_TEXT,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 24,
  },
  body: {
    color: COLOR_TEXT,
    fontSize: 16,
    textAlign: 'center',
  },
  bodyDim: {
    color: COLOR_DIM,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
  },
  linkish: {
    color: COLOR_PRIMARY,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
  },
  label: {
    color: COLOR_DIM,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  pairingCode: {
    color: COLOR_PRIMARY,
    fontSize: 56,
    fontWeight: '700',
    letterSpacing: 6,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    marginBottom: 16,
  },
  col: {
    alignItems: 'stretch',
    marginTop: 24,
  },
  spacer: { height: 12 },
  btn: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: COLOR_PRIMARY,
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLOR_BORDER,
  },
  btnText: {
    color: '#0d0d0d',
    fontWeight: '700',
    fontSize: 16,
  },
  input: {
    color: COLOR_TEXT,
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 6,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    borderRadius: 12,
    paddingVertical: 14,
    fontVariant: ['tabular-nums'],
  },
  rangingHeader: {
    color: COLOR_PRIMARY,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 18,
    letterSpacing: 1.5,
  },
  readoutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLOR_BORDER,
  },
  readoutLabel: {
    color: COLOR_DIM,
    fontSize: 14,
  },
  readoutValue: {
    color: COLOR_TEXT,
    fontSize: 22,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  dotWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 220,
    marginTop: 24,
  },
  dot: {
    width: 160,
    height: 160,
    borderRadius: 80,
  },
  bottom: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 32,
  },
});
