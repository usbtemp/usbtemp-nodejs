const EventEmitter = require('events');
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

const removeListener = (port, ev) =>
{
  port.listeners(ev).forEach(element => {
    port.removeListener(ev, element);
  });
};

// Promise wrappers so each serial operation finishes before the next one starts.
const serialFlush = port => new Promise((resolve, reject) =>
  port.flush(err => err ? reject(err) : resolve()));

const serialUpdate = (port, baudRate) => new Promise((resolve, reject) =>
  port.update({baudRate}, err => err ? reject(err) : resolve()));

const serialRead = (port, n) => new Promise((resolve, reject) =>
{
  var timeout = setTimeout(() => {
    removeListener(port, 'data');
    reject(new Error('Read timeout'));
  }, 500);
  var buf = Buffer.alloc(0);
  port.on('data', bytes => {
    buf = Buffer.concat([buf, bytes]);
    if (buf.length == n) {
      clearTimeout(timeout);
      removeListener(port, 'data');
      resolve(buf);
    }
  })
});

// Discard stale input, then send buf and wait for n bytes back. The flush must finish
// before writing, otherwise it can run after the reply has arrived and discard it.
const transfer = async(port, buf, n) =>
{
  await serialFlush(port);
  const reading = serialRead(port, n);
  port.write(buf);
  return reading;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const owReset = async port =>
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
    throw new Error('Presence error');
  }
};

const owWriteByte = async(port, byte) =>
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
};

const owWrite = async(port, byte) =>
{
  const w = await owWriteByte(port, byte);
  if (w != byte) {
    throw new Error('Invalid response');
  }
};

const owRead = port => owWriteByte(port, 0xff);

const lsb_crc8 = (bytes, generator) =>
{
  var crc = 0;
  bytes.forEach((byte) => {
    crc ^= byte;
    for (var i = 0; i < 8; i++) {
      var bit = crc & 0x01;
      crc >>= 1;
      if (bit) {
        crc ^= generator;
      }
    }
  });
  return crc
};

// Reset the bus and send the command bytes.
const command = async(port, ...bytes) =>
{
  await owReset(port);
  for (const byte of bytes) {
    await owWrite(port, byte);
  }
};

// Read n bytes; the last one is the CRC of the bytes before it.
const readBlock = async(port, n) =>
{
  const buf = Buffer.alloc(n);
  for (var i = 0; i < n; i++) {
    buf.writeUInt8(await owRead(port), i);
  }
  if (lsb_crc8(buf, generator)) {
    throw new Error('Invalid CRC');
  }
  return buf;
};

// Read the scratchpad and check that it comes from a DS18B20.
const readScratchpad = async port =>
{
  await command(port, cmdSkipRom, cmdReadScratchpad);
  const sp = await readBlock(port, spSize);
  if ((sp[spConfig] & configMask) != configFixed) {
    throw new Error('Invalid device');
  }
  return sp;
};

const precisionToConfig = precision => configFixed | ((precision - minPrecision) << 5);
const configToPrecision = config => ((config >> 5) & 0x03) + minPrecision;

class Thermometer extends EventEmitter {

  constructor(port) {
    super();
    this.serialport = new SerialPort({autoOpen: false, baudRate: resetBaud, path: port});
    this.serialport.once('open', () => this.emit('open'));
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
      throw new RangeError(`Precision must be between ${minPrecision} and ${maxPrecision} bits`);
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
