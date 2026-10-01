import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

// Repro for: expo-camera (Android) leaves a full-window white foreground on the
// Activity's DecorView when the CameraView is unmounted shortly after
// takePictureAsync() while animateShutter is true (the default).
//
// Every trial: mount the CameraView, wait until it is ready, call
// takePictureAsync() WITHOUT awaiting it, then after `delay` ms unmount the
// CameraView and show a dark "Result" screen. If the bug hits, the Result
// screen is covered by solid white even though it is rendered and interactive.

const STEP_MS = 25;
const SETTLE_AFTER_READY_MS = 1200; // let the preview settle before capturing
const RESULT_HOLD_MS = 6000; // how long the auto sweep shows each Result screen

type Phase = 'camera' | 'result';

const log = (msg: string) => console.log(`[repro] ${msg}`);

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('camera');
  const [delayMs, setDelayMs] = useState(300);
  const [animateShutter, setAnimateShutter] = useState(true);
  const [sweepMaxMs, setSweepMaxMs] = useState(600);
  const [sweeping, setSweeping] = useState(false);
  const [trial, setTrial] = useState(0);
  const [lastDelay, setLastDelay] = useState<number | null>(null);

  const cameraRef = useRef<CameraView>(null);
  const readyWaiter = useRef<(() => void) | null>(null);
  const isReady = useRef(false);
  const sweepAbort = useRef(false);

  const onCameraReady = useCallback(() => {
    isReady.current = true;
    readyWaiter.current?.();
    readyWaiter.current = null;
  }, []);

  const waitForReady = () =>
    new Promise<void>((resolve) => {
      if (isReady.current) resolve();
      else readyWaiter.current = resolve;
    });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // One trial. Resolves once the Result screen is showing.
  const runTrial = useCallback(
    async (n: number, d: number) => {
      const cam = cameraRef.current;
      if (!cam) return;
      setTrial(n);
      setLastDelay(d);
      const t0 = Date.now();
      log(`CAPTURE trial=${n} delay=${d} animateShutter=${animateShutter}`);
      cam
        .takePictureAsync({ quality: 0.5 })
        .then(() => log(`PICTURE_RESOLVED trial=${n} after=${Date.now() - t0}ms`))
        .catch((e) => log(`PICTURE_REJECTED trial=${n} after=${Date.now() - t0}ms ${String(e)}`));
      await sleep(d);
      isReady.current = false;
      setPhase('result');
      log(`UNMOUNT trial=${n} delay=${d} actual=${Date.now() - t0}ms`);
    },
    [animateShutter],
  );

  const captureOnce = async () => {
    await runTrial(trial + 1, delayMs);
  };

  const backToCamera = () => {
    setPhase('camera');
  };

  const startSweep = async () => {
    sweepAbort.current = false;
    setSweeping(true);
    let n = 0;
    log(`SWEEP_START max=${sweepMaxMs} step=${STEP_MS} animateShutter=${animateShutter}`);
    for (let d = 0; d <= sweepMaxMs && !sweepAbort.current; d += STEP_MS) {
      n += 1;
      setTrial(n);
      setLastDelay(d);
      setPhase('camera');
      await waitForReady();
      log(`CAMERA_READY trial=${n}`);
      await sleep(SETTLE_AFTER_READY_MS);
      await runTrial(n, d);
      log(`RESULT_SHOWN trial=${n} delay=${d}`);
      await sleep(RESULT_HOLD_MS);
    }
    log('SWEEP_DONE');
    setSweeping(false);
    setPhase('result');
  };

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [permission, requestPermission]);

  if (!permission) return <View style={styles.dark} />;
  if (!permission.granted) {
    return (
      <View style={[styles.dark, styles.center]}>
        <Text style={styles.text}>Camera permission is required.</Text>
        <Btn id="grant" label="Grant permission" onPress={requestPermission} />
      </View>
    );
  }

  if (phase === 'result') {
    return (
      <View style={[styles.dark, styles.center]} testID="result-screen">
        <StatusBar style="light" />
        <Text style={styles.resultTitle} testID="result-title">
          RESULT
        </Text>
        <Text style={styles.text} testID="result-info">
          {`trial ${trial} | delay ${lastDelay ?? '-'} ms | animateShutter ${animateShutter ? 'ON' : 'OFF'}`}
        </Text>
        <Text style={styles.hint}>
          This screen is dark. If you see solid white instead, the bug reproduced.
        </Text>
        {!sweeping && <Btn id="back" label="Back to camera" onPress={backToCamera} />}
        {sweeping && <Btn id="stop" label="Stop sweep" onPress={() => (sweepAbort.current = true)} />}
      </View>
    );
  }

  return (
    <View style={styles.dark}>
      <StatusBar style="light" />
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        animateShutter={animateShutter}
        onCameraReady={onCameraReady}
      />
      <View style={styles.panel}>
        <Text style={styles.text} testID="camera-info">
          {sweeping
            ? `SWEEP trial ${trial} | delay ${lastDelay ?? 0} ms`
            : `delay ${delayMs} ms | trial ${trial}`}
        </Text>
        <View style={styles.row}>
          <Text style={styles.text}>animateShutter</Text>
          <Switch
            testID="animate-shutter-switch"
            value={animateShutter}
            onValueChange={setAnimateShutter}
            disabled={sweeping}
          />
          <Text style={styles.text} testID="animate-shutter-state">
            {animateShutter ? 'ON' : 'OFF'}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.text}>delay</Text>
          <Btn id="delay-minus" label={`-${STEP_MS}`} onPress={() => setDelayMs((v) => Math.max(0, v - STEP_MS))} />
          <Text style={styles.text}>{delayMs} ms</Text>
          <Btn id="delay-plus" label={`+${STEP_MS}`} onPress={() => setDelayMs((v) => v + STEP_MS)} />
        </View>
        <View style={styles.row}>
          <Text style={styles.text}>sweep 0..</Text>
          <Btn id="sweep-max-minus" label="-100" onPress={() => setSweepMaxMs((v) => Math.max(0, v - 100))} />
          <Text style={styles.text}>{sweepMaxMs} ms</Text>
          <Btn id="sweep-max-plus" label="+100" onPress={() => setSweepMaxMs((v) => v + 100)} />
        </View>
        <View style={styles.row}>
          <Btn id="capture" label="Capture" onPress={captureOnce} disabled={sweeping} />
          <Btn id="sweep" label="Auto sweep" onPress={startSweep} disabled={sweeping} />
        </View>
      </View>
    </View>
  );
}

function Btn(props: { id: string; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      testID={props.id}
      accessibilityRole="button"
      onPress={props.onPress}
      disabled={props.disabled}
      style={[styles.btn, props.disabled && { opacity: 0.4 }]}
    >
      <Text style={styles.btnText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#101418' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    paddingBottom: 48,
    gap: 10,
    backgroundColor: 'rgba(16,20,24,0.85)',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  text: { color: '#d8dee9', fontSize: 16 },
  hint: { color: '#8a94a6', fontSize: 14, textAlign: 'center' },
  resultTitle: { color: '#d8dee9', fontSize: 40, fontWeight: '700' },
  btn: { backgroundColor: '#2e3a4a', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  btnText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
});
