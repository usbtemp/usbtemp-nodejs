const EventEmitter = require('events');
const { promisify } = require('util');
const { setTimeout: sleep } = require('timers/promises');
const { SerialPort } = require('serialport');

const generator = 0x8c;
const romSize = 8;
const spSize = 9;
const spTh = 2;
const spTl = 3;
const spConfig = 4;

// Configuration register: bits 6:5 hold the resolution R1:R0, the other bits are fixed.
const configMask = 0x9f;
const configFixed = 0x1f;
const minPrecision = 9;
const maxPrecision = 12;

// DS18B20 commands.
const cmdReadRom = 0x33;
const cmdSkipRom = 0xcc;
const cmdConvertT = 0x44;
const cmdReadScratchpad = 0xbe;
const cmdWriteScratchpad = 0x4e;
const cmdCopyScratchpad = 0x48;

// 1-wire over UART: the reset pulse is sent at a low speed, data bits at a high one.
const resetBaud = 9600;
const dataBaud = 115200;

// Milliseconds to wait for the adapter's reply.
const readTimeout = 500;

// Promise versions so each serial operation finishes before the next one starts.
function serialFlush(port)
{
  return promisify(port.flush).call(port);
}

function serialUpdate(port, baudRate)
{
  return promisify(port.update).call(port, {baudRate});
}

// Wait for n bytes. Returns the promise and a cancel function that rejects it early.
function serialRead(port, n)
{
  var cancel;
  const promise = new Promise(function(resolve, reject) {
    var buf = Buffer.alloc(0);
    var timeout;

    function done(err, result) {
      clearTimeout(timeout);
      port.removeListener('data', onData);
      if (err) {
        reject(err);
      }
      else {
        resolve(result);
      }
    }

    function onData(bytes) {
      buf = Buffer.concat([buf, bytes]);
      if (buf.length >= n) {
        done(null, buf.subarray(0, n));
      }
    }

    timeout = setTimeout(function() {
      done(new Error('Read timeout'));
    }, readTimeout);
    port.on('data', onData);
    cancel = done;
  });
  return {promise, cancel};
}

// Discard stale input, then send buf and wait for n bytes back. The flush must finish
// before writing, otherwise it can run after the reply has arrived and discard it.
// A failed write rejects at once instead of ending as a read timeout.
async function transfer(port, buf, n)
{
  await serialFlush(port);
  const reading = serialRead(port, n);
  port.write(buf, function(err) {
    if (err) {
      reading.cancel(err);
    }
  });
  return reading.promise;
}

async function owReset(port)
{
  var rbuff;
  await serialUpdate(port, resetBaud);
  try {
    const buf = await transfer(port, Buffer.from([0xf0]), 1);
    rbuff = buf[0];
  }
  finally {
    // Always return to data speed, even if the read timed out.
    await serialUpdate(port, dataBaud);
  }
  if (rbuff == 0xf0) {
    throw new Error('No device present');
  }
  else if (rbuff == 0x00) {
    throw new Error('Short circuit');
  }
  else if (!(0x10 <= rbuff && rbuff <= 0xe0)) {
    throw new Error('Presence error: 0x' + rbuff.toString(16).padStart(2, '0'));
  }
}

async function owWriteByte(port, byte)
{
  const wbuff = Buffer.alloc(8);
  for (var i = 0; i < 8; i++) {
    wbuff.writeUInt8(byte & 0x01 ? 0xff : 0x00, i);
    byte >>= 1;
  }
  const rbuff = await transfer(port, wbuff, 8);
  var value = 0;
  for (var i = 0; i < 8; i++) {
    value >>= 1;
    if (rbuff.readUInt8(i) == 0xff) {
      value |= 0x80;
    }
  }
  return value;
}

async function owWrite(port, byte)
{
  const w = await owWriteByte(port, byte);
  if (w != byte) {
    throw new Error('Invalid response');
  }
}

function owRead(port)
{
  return owWriteByte(port, 0xff);
}

function lsb_crc8(bytes, generator)
{
  var crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (var i = 0; i < 8; i++) {
      var bit = crc & 0x01;
      crc >>= 1;
      if (bit) {
        crc ^= generator;
      }
    }
  }
  return crc;
}

// Reset the bus and send the command bytes.
async function command(port, ...bytes)
{
  if (!port.isOpen) {
    throw new Error('Device is not connected');
  }
  await owReset(port);
  for (const byte of bytes) {
    await owWrite(port, byte);
  }
}

// Read n bytes; the last one is the CRC of the bytes before it.
async function readBlock(port, n)
{
  const buf = Buffer.alloc(n);
  for (var i = 0; i < n; i++) {
    buf.writeUInt8(await owRead(port), i);
  }
  if (lsb_crc8(buf, generator)) {
    throw new Error('CRC error');
  }
  return buf;
}

// Read the scratchpad and check that it comes from a DS18B20.
async function readScratchpad(port)
{
  await command(port, cmdSkipRom, cmdReadScratchpad);
  const sp = await readBlock(port, spSize);
  if ((sp[spConfig] & configMask) != configFixed) {
    throw new Error('Invalid device');
  }
  return sp;
}

function precisionToConfig(precision)
{
  return configFixed | ((precision - minPrecision) << 5);
}

function configToPrecision(config)
{
  return ((config >> 5) & 0x03) + minPrecision;
}

class Thermometer extends EventEmitter {

  constructor(port) {
    super();
    this.serialport = new SerialPort({autoOpen: false, baudRate: resetBaud, path: port});
    this.serialport.once('open', this.emit.bind(this, 'open'));
    // Report port errors, e.g. a failed Open(), on the Thermometer itself.
    this.serialport.on('error', this.emit.bind(this, 'error'));
  }

  Open() {
    this.serialport.open();
  }

  Close() {
    this.serialport.close();
  }
  
  async Rom() {
    await command(this.serialport, cmdReadRom);
    return readBlock(this.serialport, romSize);
  }

  // Start a temperature conversion.
  async Measure() {
    await command(this.serialport, cmdSkipRom, cmdConvertT);
  }

  // Read the result of the last conversion, in degrees Celsius.
  async Acquire() {
    const sp = await readScratchpad(this.serialport);
    return sp.readInt16LE(0) / 16;
  }

  async Temperature() {
    await this.Measure();
    await sleep(800);
    return this.Acquire();
  }

  // Set the resolution (9..12 bits) and save it to the probe's EEPROM.
  async SetPrecision(precision) {
    if (!Number.isInteger(precision) || precision < minPrecision || precision > maxPrecision) {
      throw new RangeError('Precision must be between ' + minPrecision + ' and ' + maxPrecision + ' bits');
    }
    const config = precisionToConfig(precision);
    const sp = await readScratchpad(this.serialport);
    if (sp[spConfig] == config) {
      return;
    }
    // Write Scratchpad: TH, TL and config (TH/TL kept as they are).
    await command(this.serialport, cmdSkipRom, cmdWriteScratchpad, sp[spTh], sp[spTl], config);
    // Copy Scratchpad to EEPROM so the setting survives power loss.
    await command(this.serialport, cmdSkipRom, cmdCopyScratchpad);
  }

  // Current resolution, 9..12 bits.
  async GetPrecision() {
    const sp = await readScratchpad(this.serialport);
    return configToPrecision(sp[spConfig]);
  }
}

Thermometer.MinPrecision = minPrecision;
Thermometer.MaxPrecision = maxPrecision;

module.exports.Thermometer = Thermometer;
