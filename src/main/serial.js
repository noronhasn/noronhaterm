'use strict';
// Sessão serial (COM no Windows, /dev/tty* no Linux) via módulo serialport.

const PARITY = ['none', 'even', 'odd', 'mark', 'space'];

function normalizeSerial(cfg = {}) {
  const baud = Number(cfg.baud) || 9600;
  const dataBits = [5, 6, 7, 8].includes(Number(cfg.dataBits)) ? Number(cfg.dataBits) : 8;
  const stopBits = Number(cfg.stopBits) === 2 ? 2 : 1;
  const parity = PARITY.includes(cfg.parity) ? cfg.parity : 'none';
  const flow = ['none', 'rtscts', 'xonxoff'].includes(cfg.flow) ? cfg.flow : 'none';
  if (!cfg.port) throw new Error('Escolha a porta serial');
  return { path: cfg.port, baudRate: baud, dataBits, stopBits, parity, rtscts: flow === 'rtscts', xon: flow === 'xonxoff', xoff: flow === 'xonxoff' };
}

async function listPorts() {
  const { SerialPort } = require('serialport');
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || '', vendorId: p.vendorId || '', productId: p.productId || '' }));
}

class SerialSession {
  constructor({ host, onData, onClose, onStatus }) {
    this.host = host;
    this.onData = onData;
    this.onClose = onClose;
    this.onStatus = onStatus;
  }

  start() {
    const opts = normalizeSerial(this.host.serial);
    const { SerialPort } = require('serialport');
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({ ...opts, autoOpen: false });
      this.port.on('data', (d) => this.onData(d));
      this.port.on('error', (e) => this.onStatus('Erro serial: ' + e.message));
      this.port.on('close', () => { if (!this.closed) { this.closed = true; this.onClose('Porta serial fechada'); } });
      this.port.open((err) => {
        if (err) {
          const dica = /EACCES|permission/i.test(err.message) && process.platform === 'linux'
            ? ' — sem permissão na porta. No terminal rode: sudo usermod -aG dialout $USER  (depois saia da sessão e entre de novo)'
            : '';
          return reject(new Error(`Não foi possível abrir ${opts.path}: ${err.message}${dica}`));
        }
        this.onStatus(`${opts.path} aberta a ${opts.baudRate} ${opts.dataBits}${opts.parity[0].toUpperCase()}${opts.stopBits}`);
        (this.host.startupCommands || []).forEach((c, i) => setTimeout(() => this.write(c + '\r'), 300 * (i + 1)));
        resolve();
      });
    });
  }

  write(data) { if (this.port && this.port.isOpen) this.port.write(data); }
  resize() { /* serial não tem janela */ }
  close() { this.closed = true; if (this.port && this.port.isOpen) this.port.close(); }
}

module.exports = { SerialSession, listPorts, normalizeSerial };
