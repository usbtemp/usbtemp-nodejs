# usbtemp-nodejs
Source code for `Thermometer` class. Requires `serialport` module.

### Installation
```
npm i https://github.com/usbtemp/usbtemp-nodejs.git
```

### Usage
```
const usbtemp = require('usbtemp');
const thermometer = new usbtemp.Thermometer('/dev/ttyUSB0');

thermometer.once('open', async() =>
{
  var rom = await thermometer.Rom();
  console.log("ROM: " + rom.toString('hex'));

  var temperature = await thermometer.Temperature();
  console.log("Temperature: " + temperature.toFixed(2));

  thermometer.Close();
});

thermometer.Open();
```

This software is in alpha stage, contributions are welcome.

#### Note
When installing dependency serialport *g++* and *make* are needed, at least on Debian/Ubuntu.

This version works on Debian 11 with nodejs v12 from its repository.