# usbtemp-nodejs
Node.js `Thermometer` class for the [usbtemp.com USB thermometer](https://usbtemp.com/) and DS9097E compatible 1-wire adapters with one DS18B20 digital probe attached. Requires the [`serialport`](https://serialport.io/) module.

### Requirements
Node.js 16 or newer and `serialport` 12.x, e.g. Debian 12 (bookworm) or Debian 13 (trixie) with Node.js from its repository:
```
sudo apt install nodejs npm
```
`serialport` downloads a prebuilt native module. If none is available for the platform, it is compiled, which needs *g++*, *make* and *python3* (`sudo apt install build-essential python3`).

On Linux the user needs read/write access to the serial port, usually by being a member of the `dialout` group.

### Installation
```
npm i https://github.com/usbtemp/usbtemp-nodejs.git
```

### Usage
```js
const usbtemp = require('usbtemp');
const thermometer = new usbtemp.Thermometer('/dev/ttyUSB0');

thermometer.on('error', function(e) {
  console.error(e.message);
});

thermometer.once('open', async function()
{
  try {
    const rom = await thermometer.Rom();
    console.log('ROM: ' + rom.toString('hex'));

    const temperature = await thermometer.Temperature();
    console.log('Temperature: ' + temperature.toFixed(2));
  }
  catch (e) {
    console.error(e.message);
  }
  finally {
    thermometer.Close();
  }
});

thermometer.Open();
```

`example.js` does the same and also prints the precision; the serial port is its optional argument:
```
node example.js /dev/ttyUSB0
```

### Thermometer class
| Member | Description |
|---|---|
| `new Thermometer(path)` | serial port, e.g. `'/dev/ttyUSB0'` or `'COM3'` |
| `Open()` | open the port; the `'open'` event is emitted when it is ready, failures are emitted as `'error'` |
| `Close()` | close the port |
| `async Rom()` | probe serial number, `Buffer` of 8 bytes |
| `async Measure()` | start temperature conversion |
| `async Acquire()` | result of the last conversion, in degrees Celsius |
| `async Temperature()` | `Measure()`, wait 800 ms, `Acquire()` |
| `async SetPrecision(bits)` | set resolution 9..12 bits, saved to probe EEPROM |
| `async GetPrecision()` | current resolution, 9..12 bits |
| `Thermometer.MinPrecision` | lowest resolution, 9 bits |
| `Thermometer.MaxPrecision` | highest resolution, 12 bits |

Use `Measure()` and `Acquire()` instead of `Temperature()` to wait less at lower resolution:

| Resolution | Step | Conversion time |
|---|---|---|
| 9 bits | 0.5 °C | 94 ms |
| 10 bits | 0.25 °C | 188 ms |
| 11 bits | 0.125 °C | 375 ms |
| 12 bits | 0.0625 °C | 750 ms |

### Errors
The async methods reject with an `Error`:

| Message | Cause |
|---|---|
| `Device is not connected` | `Open()` was not called or the port is closed |
| `Read timeout` | the adapter does not answer within 500 ms |
| `No device present` | no probe is connected |
| `Short circuit` | the 1-wire bus is shorted |
| `Presence error: 0x..` | unexpected response to the bus reset |
| `Invalid response` | a byte sent to the probe was not echoed back correctly |
| `CRC error` | the data read from the probe is corrupted |
| `Invalid device` | the probe is not a DS18B20 |

Errors of the serial port itself, e.g. when it is closed during a measurement, are passed through.

Errors outside a method call, such as a port that cannot be opened, are emitted as an `'error'` event on the `Thermometer`. As with any `EventEmitter`, an `'error'` event without a listener throws, so add one.

`SetPrecision()` rejects with a `RangeError` when the resolution is not an integer between 9 and 12.

### Changes
**0.0.4**
* Errors reject the returned promise; before, a missing probe or a timeout left the call waiting forever.
* The serial port is always switched back to data speed after a failed bus reset.
* Fixed occasional lost replies: input is flushed before, not while, sending.
* A failed write rejects the call with the serial port's error instead of `Read timeout`.
* Serial port errors, e.g. a failed `Open()`, are emitted as `'error'` on the `Thermometer`.
* Error messages are the same as in the C# and Python libraries.
* Added `Measure()`, `Acquire()`, `SetPrecision()`, `GetPrecision()` and the DS18B20 device check.
* `serialport` updated from 10.4 to 12.0, Node.js 16 or newer is required.

This software is in alpha stage, contributions are welcome.
