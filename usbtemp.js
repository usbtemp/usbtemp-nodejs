const EventEmitter = require('events');
const SerialPort = require('serialport');

const generator = 0x8c;

const serialWrite = (port, buf) => new Promise((resolve, reject) =>
{
  port.flush();
  port.write(buf);
  return resolve();
});

const serialRead = (port, n) => new Promise((resolve, reject) =>
{
  var timeout = setTimeout(() => {
    port.listeners('data').forEach(element => {
      port.removeListener('data', element);
    });
    reject(new Error('Read timeout'));
  }, 500);
  var buf = new Buffer(0);
  port.on('data', bytes => {
    buf = Buffer.concat([buf, bytes]);
    if (buf.length == n) {
      port.listeners('data').forEach(element => {
        port.removeListener('data', element);
      });
      clearTimeout(timeout);
      resolve(buf);
    }
  })
});

const owReset = port => new Promise(async(resolve, reject) =>
{
  port.update({baudRate: 9600});
  const wbuff = new Buffer(1);
  wbuff.writeUInt8(0xf0, 0);
  serialWrite(port, wbuff);
  const buf = await serialRead(port, 1);
  port.update({baudRate: 115200});
  const rbuff = buf[0];
  if (rbuff == 0xf0) {
	  return reject(new Error('No device present'));
  }
  else if (rbuff == 0x00) {
    return reject(new Error('Short circuit'));
  }
  else if (0x10 <= rbuff && rbuff <= 0xe0) {
    return resolve();
  }
  else {
    return reject(new Error('Presence error'));
  }
});

const owWriteByte = (port, byte) => new Promise(async(resolve, reject) =>
{
  const wbuff = new Buffer(8);
  for (var i = 0; i < 8; i++) {
    wbuff.writeUInt8(byte & 0x01 ? 0xff : 0x00, i);
    byte >>= 1;
  }
  serialWrite(port, wbuff);
  const rbuff = await serialRead(port, 8);
  var value = 0;
  for (var i = 0; i < 8; i++) {
    value >>= 1;
    if (rbuff.readUInt8(i) == 0xff) {
      value |= 0x80;
    }
  }
  return resolve(value);
});

const owWrite = (port, byte) => new Promise(async(resolve, reject) =>
{
  const w = await owWriteByte(port, byte);
  if (w == byte) {
    return resolve(); 
  }
  return reject(new Error('Invalid response'));
});

const owRead = port => new Promise(async(resolve, reject) =>
{
  const byte = await owWriteByte(port, 0xff);
  return resolve(byte);
});

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

class Thermometer extends EventEmitter {

  constructor(port) {
    super();
    this.serialport = new SerialPort(port);
    this.serialport.once('open', () => this.emit('open'));
  }

  Close() {
    this.serialport.close();
  }
  
  Rom() {
    return new Promise(async(resolve, reject) => {
      await owReset(this.serialport);
      await owWrite(this.serialport, 0x33);
      var rom = new Buffer(8);
      for (var i = 0; i < 8; i++) {
        var value = await owRead(this.serialport);
        rom.writeUInt8(value, i);
      }
      if (lsb_crc8(rom.slice(0, 7), generator) == rom.readUInt8(7)) {
        return resolve(rom);
      }
      return reject(new Error('Invalid CRC'));
    });
  }

  Temperature() {
    return new Promise(async(resolve, reject) => {
      await owReset(this.serialport);
      await owWrite(this.serialport, 0xcc);
      await owWrite(this.serialport, 0x44);

      setTimeout(async() => {
        await owReset(this.serialport);
        await owWrite(this.serialport, 0xcc);
        await owWrite(this.serialport, 0xbe);
        var sp = new Buffer(9);
        for (var i = 0; i < 9; i++) {
          var value = await owRead(this.serialport);
          sp.writeUInt8(value, i);
        }
        if (lsb_crc8(sp.slice(0, 8), generator) == sp.readUInt8(8)) {
          const temp = sp.readInt16LE(0);
          return resolve(temp / 16);
        }
        return reject(new Error('Invalid CRC'));
      }, 800);
      
    });
  }
}

module.exports.Thermometer = Thermometer;
