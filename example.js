// Print the probe serial number, precision and temperature.
// Usage: node example.js [port], e.g. node example.js /dev/ttyUSB0 or node example.js COM3

const { Thermometer } = require('./usbtemp');

const port = process.argv[2] || '/dev/ttyUSB0';
const thermometer = new Thermometer(port);

thermometer.on('error', function(e) {
  console.error(e.message);
  process.exitCode = 1;
});

thermometer.once('open', async function()
{
  try {
    console.log('Serial: ' + (await thermometer.Rom()).toString('hex'));
    console.log('Precision: ' + await thermometer.GetPrecision());
    console.log('Temperature C: ' + (await thermometer.Temperature()).toFixed(2));
  }
  catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  finally {
    thermometer.Close();
  }
});

thermometer.Open();
