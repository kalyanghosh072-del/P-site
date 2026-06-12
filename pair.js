'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const pino    = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

let router = express.Router();

const SESSIONS_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cleanup(sessionId, entry) {
  if (entry.cleaned) return;
  entry.cleaned = true;
  try {
    if (entry.socket) { entry.socket.ws?.close(); entry.socket = null; }
    const dir = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  setTimeout(() => sessions.delete(sessionId), 60000);
}

async function startSession(sessionId, phone) {
  const authDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const entry = {
    status: 'waiting',
    pairingCode: null,
    error: null,
    phone,
    socket: null,
    cleaned: false,
  };
  sessions.set(sessionId, entry);

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: authState,
      browser: Browsers.macOS('Safari'),
    });

    entry.socket = sock;
    sock.ev.on('creds.update', saveCreds);

    if (!authState.creds.registered) {
      await sleep(2000);
      try {
        const raw = await sock.requestPairingCode(phone);
        entry.pairingCode = raw?.match(/.{1,4}/g)?.join('-') ?? raw;
        entry.status = 'paired';
      } catch (err) {
        entry.status = 'error';
        entry.error  = err.message;
        cleanup(sessionId, entry);
      }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        entry.status = 'connected';
        await sleep(3000);
        cleanup(sessionId, entry);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          // Reconnect once
          setTimeout(() => startSession(sessionId, phone), 3000);
        } else {
          cleanup(sessionId, entry);
        }
      }
    });

  } catch (err) {
    entry.status = 'error';
    entry.error  = err.message;
    cleanup(sessionId, entry);
  }
}

// GET /code?number=917029666180
router.get('/', async (req, res) => {
  let num = (req.query.number || '').replace(/\D/g, '');
  if (!num || num.length < 7) {
    return res.json({ code: 'Invalid number' });
  }

  const sessionId = uuidv4();

  // Start session in background
  startSession(sessionId, num);

  // Poll for pairing code up to 15s
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(500);
    const entry = sessions.get(sessionId);
    if (!entry) break;
    if (entry.pairingCode) {
      return res.json({ code: entry.pairingCode });
    }
    if (entry.status === 'error') {
      return res.json({ code: entry.error || 'Service Unavailable' });
    }
  }

  return res.json({ code: 'Timeout - try again' });
});

module.exports = router;
