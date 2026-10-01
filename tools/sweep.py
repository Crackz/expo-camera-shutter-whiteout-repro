#!/usr/bin/env python3
"""Drive the in-app auto sweep over adb and classify every trial.

Usage: python3 tools/sweep.py --serial emulator-5554 --animate on|off [--max 600] [--out results.json]

Needs: adb on PATH, numpy + Pillow (pip install numpy pillow), the release build installed and
showing the camera screen with camera permission granted.

For every trial it takes:
  * a screenshot while the camera is showing (before the capture), so a white
    carried over from the previous trial is not counted twice;
  * a screenshot 0.8 s after the Result screen mounted; when that one is white,
    a uiautomator dump (to prove the Result screen of THIS trial is the one being
    shown) and a second screenshot 2.5 s after the mount.
A trial is WHITE when the Result screenshots are (almost) exactly #FFFFFF while
the dump still shows the Result screen text.
"""
import argparse, io, json, queue, re, subprocess, sys, threading, time
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image

PKG = 'com.example.shutterrepro'
WHITE_FRACTION = 0.97  # share of exact #FFFFFF pixels to call a frame white


def adb(serial, *args, binary=False, timeout=30):
    out = subprocess.run(['adb', '-s', serial, *args], capture_output=True, timeout=timeout)
    return out.stdout if binary else out.stdout.decode(errors='replace')


def frame_stats(serial):
    png = adb(serial, 'exec-out', 'screencap', '-p', binary=True)
    a = np.asarray(Image.open(io.BytesIO(png)).convert('RGB'))
    white = np.all(a == 255, axis=2)
    return {'white_fraction': round(float(white.mean()), 4), 'mean': round(float(a.mean()), 2),
            'row0_mean': round(float(a[0].mean()), 2)}


def dump(serial):
    xml = adb(serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty')
    xml = xml[xml.find('<?xml'):xml.rfind('>') + 1] if '<?xml' in xml else ''
    try:
        return ET.fromstring(xml.replace('UI hierchary dumped to: /dev/tty', ''))
    except ET.ParseError:
        return None


def node_by_id(root, rid):
    for n in root.iter('node'):
        if n.get('resource-id') == rid:
            return n
    return None


def center(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    return (x1 + x2) // 2, (y1 + y2) // 2


def tap_id(serial, rid):
    root = dump(serial)
    n = node_by_id(root, rid) if root is not None else None
    if n is None:
        sys.exit(f'element {rid} not found on screen')
    x, y = center(n)
    adb(serial, 'shell', 'input', 'tap', str(x), str(y))
    time.sleep(0.6)


def text_of(serial, rid):
    root = dump(serial)
    n = node_by_id(root, rid) if root is not None else None
    return n.get('text') if n is not None else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--serial', required=True)
    ap.add_argument('--animate', choices=['on', 'off'], required=True)
    ap.add_argument('--max', type=int, default=600)
    ap.add_argument('--out')
    ap.add_argument('--deadline', type=int, default=900, help='hard stop in seconds')
    a = ap.parse_args()
    s = a.serial
    t_start = time.time()

    # Fresh process, camera screen.
    adb(s, 'shell', 'am', 'force-stop', PKG)
    adb(s, 'shell', 'pm', 'grant', PKG, 'android.permission.CAMERA')
    adb(s, 'shell', 'am', 'start', '-W', '-n', f'{PKG}/.MainActivity')
    for _ in range(30):
        time.sleep(1)
        if text_of(s, 'animate-shutter-state'):
            break
    else:
        sys.exit('camera screen never showed')

    if text_of(s, 'animate-shutter-state') != a.animate.upper():
        tap_id(s, 'animate-shutter-switch')
    assert text_of(s, 'animate-shutter-state') == a.animate.upper(), 'animateShutter toggle failed'
    # Default sweep max in the app is 600 ms; step it with the +/-100 buttons.
    for _ in range(abs(a.max - 600) // 100):
        tap_id(s, 'sweep-max-plus' if a.max > 600 else 'sweep-max-minus')

    adb(s, 'logcat', '-c')
    lc = subprocess.Popen(['adb', '-s', s, 'logcat', '-v', 'brief', 'ReactNativeJS:I', '*:S'],
                          stdout=subprocess.PIPE, text=True, errors='replace')
    q = queue.Queue()
    # Stamp every line on arrival, so a step can tell when it is running late.
    threading.Thread(target=lambda: [q.put((time.time(), l)) for l in lc.stdout], daemon=True).start()

    tap_id(s, 'sweep')
    trials = {}
    try:
        while True:
            if time.time() - t_start > a.deadline:
                print('DEADLINE HIT, stopping'); break
            try:
                t_ev, line = q.get(timeout=30)
            except queue.Empty:
                print('no log for 30 s, stopping'); break
            m = re.search(r'\[repro\] (\w+)(.*)', line)
            if not m:
                continue
            ev, rest = m.group(1), m.group(2)
            kv = dict(re.findall(r'(\w+)=(\S+)', rest))
            if ev == 'SWEEP_DONE':
                break
            n = int(kv.get('trial', 0))
            t = trials.setdefault(n, {'trial': n})
            if ev == 'CAMERA_READY':
                # The capture fires 1.2 s after this event; only sample while safely before it.
                if time.time() - t_ev < 0.4:
                    t['pre'] = frame_stats(s)
            elif ev == 'CAPTURE':
                t['delay'] = int(kv['delay'])
            elif ev == 'UNMOUNT':
                t['unmount_actual_ms'] = int(kv['actual'].rstrip('ms'))
            elif ev in ('PICTURE_RESOLVED', 'PICTURE_REJECTED'):
                t['picture'] = f"{ev.split('_')[1].lower()} {kv.get('after')}"
            elif ev == 'RESULT_SHOWN':
                # The Result screen stays up for 6 s after this event.
                lag = time.time() - t_ev
                if lag > 3.0:
                    t['skipped'] = f'harness late by {lag:.1f}s'
                    print(f"trial {n:3d} skipped ({t['skipped']})", flush=True)
                    continue
                t['harness_lag_s'] = round(lag, 2)
                time.sleep(max(0, 0.8 - lag))
                t['post'] = frame_stats(s)
                t['result_text_in_tree'] = None
                if t['post']['white_fraction'] >= WHITE_FRACTION:
                    root = dump(s)
                    info = node_by_id(root, 'result-info') if root is not None else None
                    t['result_text_in_tree'] = info.get('text') if info is not None else None
                    time.sleep(max(0, t_ev + 2.5 - time.time()))
                    t['post_late'] = frame_stats(s)
                    t['post_late_at_s'] = round(time.time() - t_ev, 2)
                pre_white = t.get('pre', {}).get('white_fraction', 0) >= WHITE_FRACTION
                white = (t['post']['white_fraction'] >= WHITE_FRACTION and
                         t.get('post_late', {}).get('white_fraction', 0) >= WHITE_FRACTION and
                         bool(t['result_text_in_tree']) and f"trial {n} " in t['result_text_in_tree'])
                t['white'] = white
                t['carried_over'] = pre_white
                print(f"trial {n:3d} delay {t.get('delay', -1):4d} ms unmount@{t.get('unmount_actual_ms')}ms "
                      f"white={'YES' if white else 'no '} pre_white={'yes' if pre_white else 'no' if 'pre' in t else '?'} "
                      f"post={t['post']} tree={t['result_text_in_tree']!r}", flush=True)
    finally:
        lc.terminate()
        try:
            lc.wait(5)
        except subprocess.TimeoutExpired:
            lc.kill()

    rows = [trials[k] for k in sorted(trials) if 'white' in trials[k]]
    skipped = [k for k in sorted(trials) if 'skipped' in trials[k]]
    hits = [r for r in rows if r['white'] and not r['carried_over']]
    print(f"animateShutter={a.animate}: {len(hits)}/{len(rows)} fresh white trials; "
          f"white delays: {[r['delay'] for r in hits]}; skipped trials: {skipped}; elapsed {int(time.time() - t_start)} s")
    if a.out:
        json.dump({'animate': a.animate, 'max': a.max, 'trials': rows}, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
