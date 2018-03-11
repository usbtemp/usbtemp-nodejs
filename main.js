const usbtemp = require('./usbtemp.js');

const thermometer = new usbtemp.Thermometer('/dev/ttyUSB0');

thermometer.once('open', async() =>
{
  var rom = await thermometer.Rom()
  console.log("ROM: " + rom.toString('hex'));

  var temperature = await thermometer.Temperature();
  console.log("Temperature: " + temperature.toFixed(2));

  thermometer.Close();
});