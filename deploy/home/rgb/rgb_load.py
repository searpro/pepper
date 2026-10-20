#!/usr/bin/env python3
"""Colour the machine's RGB by CPU and GPU load.

Talks to a local `openrgb --server` over its SDK protocol and reads load
from /proc/stat and NVML, using only the standard library so it runs on the
system Python with nothing installed.

  rgb_load.py --probe        list controllers, modes and zones, then exit
  rgb_load.py --status       the mode and colour OpenRGB last sent, and the load now
  rgb_load.py --set RRGGBB   set one fixed colour (stop the service first, or it overrides it)
  rgb_load.py                run (config: /etc/rgb-load.json, all keys optional)

The colour is written as the Static mode's own colour. On the Gigabyte
B650M H (IT5701), OpenRGB's Direct mode stores colours but the LEDs never
change, and Static ignores per-LED colours, so the mode colour is the one
thing that reaches the lights. It covers the whole board: every header
shows the same colour.
"""

import ctypes
import json
import math
import socket
import struct
import sys
import time

DEFAULTS = {
    'host': '127.0.0.1',
    'port': 6742,
    'device': 0,
    # What drives the colour: "cpu", "gpu" or "max" (the busier of the two).
    'source': 'max',
    # Load 0 % is the first colour, 100 % the last; in between is interpolated.
    'gradient': ['#0030ff', '#00c8ff', '#00ff40', '#ffd000', '#ff0000'],
    'brightness': 1.0,
    'fps': 10,
    # Seconds for the shown load to cover ~63 % of a step, so the colour
    # glides instead of flickering with every sample.
    'smoothing': 0.6,
}

# OpenRGB SDK packet ids (NetworkProtocol.h).
REQUEST_CONTROLLER_COUNT = 0
REQUEST_CONTROLLER_DATA = 1
SET_CLIENT_NAME = 50
UPDATE_MODE = 1101


class OpenRGB:
    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=10)
        self._send(0, SET_CLIENT_NAME, b'rgb-load\0')

    def _send(self, dev, pkt, data=b''):
        self.sock.sendall(b'ORGB' + struct.pack('<III', dev, pkt, len(data)) + data)

    def _recv_exact(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError('OpenRGB server closed the connection')
            buf += chunk
        return buf

    def _request(self, dev, pkt, data=b''):
        self._send(dev, pkt, data)
        while True:
            head = self._recv_exact(16)
            _, rdev, rpkt, size = struct.unpack('<4sIII', head)
            body = self._recv_exact(size)
            if rpkt == pkt:
                return body

    def count(self):
        return struct.unpack('<I', self._request(0, REQUEST_CONTROLLER_COUNT))[0]

    def controller(self, dev):
        # No protocol version in the request, so the server answers in the
        # version-0 layout, which is the only one parsed here.
        return parse_controller(self._request(dev, REQUEST_CONTROLLER_DATA))

    def set_mode(self, dev, mode, color):
        # The server takes the whole mode description back: resend the bytes
        # it gave us with the mode's colour slots replaced.
        raw = mode['raw'][:len(mode['raw']) - 4 * mode['num_colors']]
        raw += struct.pack('<BBBx', *color) * mode['num_colors']
        body = struct.pack('<i', mode['index']) + raw
        self._send(dev, UPDATE_MODE, struct.pack('<I', len(body) + 4) + body)


def parse_controller(b):
    pos = 4  # data size

    def u16():
        nonlocal pos
        v = struct.unpack_from('<H', b, pos)[0]
        pos += 2
        return v

    def u32():
        nonlocal pos
        v = struct.unpack_from('<I', b, pos)[0]
        pos += 4
        return v

    def string():
        nonlocal pos
        n = u16()
        s = b[pos:pos + n].rstrip(b'\0').decode(errors='replace')
        pos += n
        return s

    u32()  # type
    name = string()
    for _ in range(4):  # description, version, serial, location
        string()
    modes = []
    num_modes = u16()
    active = u32()
    for index in range(num_modes):
        start = pos
        mname = string()
        pos += 4 * 9  # value, flags, speed min/max, colors min/max, speed, direction, color mode
        num_colors = u16()  # read first: `pos += 4 * u16()` would drop u16's advance
        colors = [tuple(b[pos + 4 * i:pos + 4 * i + 3]) for i in range(num_colors)]
        pos += 4 * num_colors
        modes.append({'index': index, 'name': mname, 'num_colors': num_colors,
                      'colors': colors, 'raw': b[start:pos]})
    zones = []
    for _ in range(u16()):
        zname = string()
        u32()  # zone type
        lo, hi, count = u32(), u32(), u32()
        if u16():
            h, w = u32(), u32()
            pos += 4 * h * w
        zones.append({'name': zname, 'min': lo, 'max': hi, 'count': count})
    return {'name': name, 'modes': modes, 'active': modes[active], 'zones': zones}


def static_mode(info):
    for m in info['modes']:
        if m['name'] == 'Static' and m['num_colors']:
            return m
    raise RuntimeError(f"{info['name']} has no Static mode with a colour")


class Cpu:
    def __init__(self):
        self.prev = self._read()

    @staticmethod
    def _read():
        with open('/proc/stat') as f:
            vals = [int(x) for x in f.readline().split()[1:]]
        idle = vals[3] + vals[4]  # idle + iowait
        return idle, sum(vals[:8])  # guest time is already inside user

    def load(self):
        idle, total = self._read()
        d_idle, d_total = idle - self.prev[0], total - self.prev[1]
        self.prev = (idle, total)
        return 0.0 if d_total <= 0 else 1.0 - d_idle / d_total


class Gpu:
    class _Util(ctypes.Structure):
        _fields_ = [('gpu', ctypes.c_uint), ('memory', ctypes.c_uint)]

    def __init__(self):
        self.nvml = ctypes.CDLL('libnvidia-ml.so.1')
        if self.nvml.nvmlInit_v2() != 0:
            raise RuntimeError('nvmlInit failed')
        self.handle = ctypes.c_void_p()
        if self.nvml.nvmlDeviceGetHandleByIndex_v2(0, ctypes.byref(self.handle)) != 0:
            raise RuntimeError('no NVIDIA GPU 0')

    def load(self):
        u = self._Util()
        if self.nvml.nvmlDeviceGetUtilizationRates(self.handle, ctypes.byref(u)) != 0:
            return 0.0
        return u.gpu / 100.0


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def colour(gradient, load, brightness):
    load = min(max(load, 0.0), 1.0) * (len(gradient) - 1)
    i = min(int(load), len(gradient) - 2)
    t = load - i
    a, b = gradient[i], gradient[i + 1]
    return tuple(round((a[k] + (b[k] - a[k]) * t) * brightness) for k in range(3))


def probe(cfg):
    rgb = OpenRGB(cfg['host'], cfg['port'])
    for dev in range(rgb.count()):
        c = rgb.controller(dev)
        print(f"{dev}: {c['name']}  modes: {', '.join(m['name'] for m in c['modes'])}")
        for z, zone in enumerate(c['zones']):
            print(f"   zone {z} {zone['name']!r}: {zone['count']} LEDs (resizable {zone['min']}-{zone['max']})")


def status(cfg):
    # What OpenRGB last sent; the controller has no way to report what the
    # LEDs actually show.
    c = OpenRGB(cfg['host'], cfg['port']).controller(cfg['device'])
    mode = c['active']
    cols = ', '.join('#%02x%02x%02x' % col for col in mode['colors']) or 'per-LED'
    print(f"{c['name']}: mode {mode['name']}, colour {cols}")
    cpu, gpu = Cpu(), Gpu()
    time.sleep(0.5)
    print(f'  load now: cpu {cpu.load():.0%}, gpu {gpu.load():.0%}')


def set_colour(cfg, hexcolour):
    rgb = OpenRGB(cfg['host'], cfg['port'])
    rgb.set_mode(cfg['device'], static_mode(rgb.controller(cfg['device'])), hex_rgb(hexcolour))
    rgb.count()  # a round trip, so the write is handled before we disconnect


def run(cfg):
    gradient = [hex_rgb(h) for h in cfg['gradient']]
    cpu, gpu = Cpu(), Gpu()
    rgb = OpenRGB(cfg['host'], cfg['port'])
    dev = cfg['device']
    mode = static_mode(rgb.controller(dev))

    period = 1.0 / cfg['fps']
    alpha = 1.0 - math.exp(-period / cfg['smoothing'])
    shown = {'cpu': 0.0, 'gpu': 0.0}
    sampled = {'cpu': 0.0, 'gpu': 0.0}
    next_sample = 0.0
    last = None
    while True:
        now = time.monotonic()
        # Load is sampled twice a second; /proc/stat ticks at 100 Hz, so
        # shorter windows only add noise.
        if now >= next_sample:
            sampled = {'cpu': cpu.load(), 'gpu': gpu.load()}
            next_sample = now + 0.5
        for k in shown:
            shown[k] += (sampled[k] - shown[k]) * alpha
        shown_max = max(shown.values())
        load = shown_max if cfg['source'] == 'max' else shown[cfg['source']]
        # Colours move in 2 % steps: smooth to the eye, and the controller
        # (USB HID) only gets a write when a step is crossed.
        col = colour(gradient, round(load * 50) / 50, cfg['brightness'])
        if col != last:
            rgb.set_mode(dev, mode, col)
            last = col
        time.sleep(max(0.0, period - (time.monotonic() - now)))


def main():
    cfg = dict(DEFAULTS)
    try:
        with open('/etc/rgb-load.json') as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
    if '--probe' in sys.argv:
        probe(cfg)
    elif '--status' in sys.argv:
        status(cfg)
    elif '--set' in sys.argv:
        set_colour(cfg, sys.argv[sys.argv.index('--set') + 1])
    else:
        # systemd restarts the unit, so a dropped or slow-starting server
        # just means trying again.
        run(cfg)


if __name__ == '__main__':
    main()
