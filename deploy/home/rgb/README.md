# Case lighting that follows load

The home box's RGB lights show how busy it is: blue when idle, through teal,
green and yellow, to red at 100 %, following whichever of the CPU and GPU is
busier. It has nothing to do with Pepper; it lives here with the rest of the
box's setup so a reinstall can bring it back.

- `openrgb.service` runs [OpenRGB](https://openrgb.org)'s SDK server as
  root (the RGB controller's `/dev/hidraw*` node is root-only over SSH),
  listening on localhost only.
- `rgb-load.service` runs `rgb_load.py` as an unprivileged dynamic user. It
  reads load from `/proc/stat` and NVML and writes the colour through the
  SDK. It needs nothing installed beyond the system Python and the NVIDIA
  driver.

## Install

On the box, with OpenRGB installed (`sudo apt install openrgb`, or a build
from openrgb.org; 0.9+ verified), from your machine:

```bash
scp deploy/home/rgb/{rgb_load.py,openrgb.service,rgb-load.service} lijin@lk-gpu-server:/tmp/
ssh lijin@lk-gpu-server 'sudo install -Dm755 /tmp/rgb_load.py /opt/rgb-load/rgb_load.py &&
  sudo install -m644 /tmp/openrgb.service /tmp/rgb-load.service /etc/systemd/system/ &&
  sudo systemctl daemon-reload && sudo systemctl enable --now openrgb rgb-load'
```

## Use

On the box:

| | |
| --- | --- |
| `python3 /opt/rgb-load/rgb_load.py --status` | The mode and colour OpenRGB last sent, and the load now |
| `sudo systemctl stop rgb-load` then `python3 /opt/rgb-load/rgb_load.py --set 0000ff` | One fixed colour (the service would override it) |
| `sudo systemctl start rgb-load` | Back to following load |
| `sudo systemctl disable --now rgb-load openrgb` | Off; the board keeps its last colour |

`/etc/rgb-load.json` overrides the defaults at the top of `rgb_load.py`
(every key optional), then `sudo systemctl restart rgb-load`:

```json
{ "source": "gpu", "gradient": ["#0030ff", "#00ff40", "#ff0000"], "brightness": 0.6 }
```

`source` is `cpu`, `gpu` or `max` (the busier of the two).

## What the board accepts

Measured on the Gigabyte B650M H (IT5701 controller, RGB Fusion 2 over
USB); the RAM and GPU have no LEDs, so `i2c-dev` is not needed.

- OpenRGB's **Direct** mode, the one meant for live colour, stores the
  colours but the LEDs never change.
- **Static** ignores per-LED colours: the driver sends the mode's own
  colour. So the script rewrites that colour with each change, which means
  one colour for the whole board. Separate CPU and GPU headers aren't
  possible this way.
- `--status` reports what OpenRGB sent, not what the LEDs show; the
  controller can't report that. Check a change by looking at the box.
