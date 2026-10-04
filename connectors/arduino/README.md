# GHOST serial firmware for Arduino

`ghost_serial/ghost_serial.ino` turns an Arduino (Uno, Nano or any board with the `Servo` library) into a GHOST device. The browser reaches it over USB with **Web Serial**. It needs no extra libraries, so ArduinoJson is not required.

## Flash it

1. Open `ghost_serial/ghost_serial.ino` in the Arduino IDE.
2. Select your board and port, then click **Upload**. `Servo` ships with the IDE. With arduino-cli, run `arduino-cli lib install Servo` first.
3. Optional: change `DEVICE_NAME`, `SERVO_PIN` or `LIGHT_PIN` at the top of the sketch.

## Wiring

| part | connection |
|---|---|
| Servo (SG90) | signal to **D9**, V+ to **5V**, GND to **GND**. For bigger servos use an external 5 V supply and share its GND with the Arduino |
| Photoresistor | 5V to photoresistor to **A0**, and A0 to a **10 kΩ** resistor to GND (voltage divider; brighter gives a higher reading) |
| LED | built-in LED on pin 13. No wiring needed |

## Protocol (115200 baud, one JSON object per line)

```
host   -> ?
device <- {"ghost":"0.1","name":"Desk Arduino","capabilities":[{"id":"led.set",...},{"id":"servo.move",...},{"id":"light.read",...}]}

host   -> {"id":"inv_1","cap":"servo.move","args":{"angle":90}}
device <- {"id":"inv_1","ok":true,"value":90,"unit":"deg"}

host   -> {"id":"inv_2","cap":"servo.move","args":{"angle":200}}
device <- {"id":"inv_2","ok":false,"error":"angle out of range (0..180)"}
```

| cap | kind | args | value |
|---|---|---|---|
| `led.set` | act | `{"on": true/false}` | `true`/`false` |
| `servo.move` | act | `{"angle": 0..180}` (out-of-range values are **rejected**) | commanded angle, unit `deg` (position is not sensed) |
| `light.read` | measure | none | raw ADC reading `0..1023`, unit `raw` (not lux) |

Input lines longer than 256 bytes are discarded and answered with `{"id":"","ok":false,"error":"line too long"}`.
The servo is only attached on the first `servo.move`, so it doesn't jump at power-up.

## Test with a serial monitor

In the Arduino IDE open **Tools → Serial Monitor**, set **115200 baud** and **Newline**, then type:

```
?
{"id":"t1","cap":"led.set","args":{"on":true}}
{"id":"t2","cap":"servo.move","args":{"angle":45}}
{"id":"t3","cap":"light.read"}
```

From a terminal you can also use `screen /dev/tty.usbmodem* 115200` on macOS, or `picocom -b 115200 /dev/ttyACM0` on Linux.

## Connect it to GHOST

1. Plug the Arduino into the computer that runs **Chrome** or **Edge** (Web Serial is Chromium-only) and close the Serial Monitor, because only one program can open the port.
2. In GHOST, choose **Connect hardware → USB serial**, then pick the board in the browser's port chooser.
3. The page sends `?`, reads the capabilities and publishes them as a device through the browser's device channel. Agents can then lease and invoke `led.set`, `servo.move` and `light.read`. The browser tab has to stay open while the device is in use.

## Status

The protocol logic (manifest, argument validation, overlong lines, JSON output) was checked by compiling the sketch on the host with stubbed Arduino APIs and feeding it test lines. **It has not been compiled with the AVR toolchain or run on a physical board yet.**
