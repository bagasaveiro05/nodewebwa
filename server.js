require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qrcode = require('qrcode');
const P = require('pino');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT || 3001);
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const APP_CALLBACK_URL = process.env.APP_CALLBACK_URL || '';
const APP_STATUS_URL = process.env.APP_STATUS_URL || '';
const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');
const AUTO_RECONNECT = String(process.env.AUTO_RECONNECT || '0') === '1';
const BAILEYS_WA_VERSION = String(process.env.BAILEYS_WA_VERSION || '').trim();
const STATE_DIR = path.join(SESSIONS_DIR, '_state');
const LOG_DIR = path.join(__dirname, 'logs');

for (const dir of [SESSIONS_DIR, STATE_DIR, LOG_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const sessions = new Map();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((v) => {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }).join(' ')}`;
  console.log(line);
  fs.appendFile(path.join(LOG_DIR, 'node.log'), line + '\n', () => {});
}

function stateFile(deviceId) {
  const safeId = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(STATE_DIR, `${safeId}.json`);
}

function writeState(deviceId, data) {
  const previous = readState(deviceId) || {};
  const payload = {
    ...previous,
    ...data,
    device_id: String(deviceId),
    updated_at: new Date().toISOString(),
    pid: process.pid
  };
  try {
    fs.writeFileSync(stateFile(deviceId), JSON.stringify(payload, null, 2));
  } catch (err) {
    log(`[device ${deviceId}] write state failed:`, err.message);
  }
  return payload;
}

function readState(deviceId) {
  try {
    const file = stateFile(deviceId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function stateCount() {
  try {
    return fs.readdirSync(STATE_DIR).filter((name) => name.endsWith('.json')).length;
  } catch (_) {
    return 0;
  }
}


function parseWaVersion(value) {
  if (!value) return null;
  const parts = String(value).split('.').map((v) => Number(v.trim()));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
  return parts;
}

async function resolveWaVersion() {
  const forced = parseWaVersion(BAILEYS_WA_VERSION);
  if (forced) {
    log(`Using forced WhatsApp Web version ${forced.join('.')}`);
    return forced;
  }

  try {
    const latest = await fetchLatestBaileysVersion();
    if (Array.isArray(latest?.version)) {
      log(`Using latest WhatsApp Web version ${latest.version.join('.')}`);
      return latest.version;
    }
  } catch (err) {
    log('fetchLatestBaileysVersion failed:', err.message);
  }

  // Fallback versi umum. Kalau QR tetap gagal, isi BAILEYS_WA_VERSION dari environment.
  const fallback = [2, 3000, 1023223821];
  log(`Using fallback WhatsApp Web version ${fallback.join('.')}`);
  return fallback;
}

function summarizeDisconnect(error) {
  if (!error) return { message: null, statusCode: null, stack: null };
  return {
    message: error?.message || String(error),
    statusCode: error?.output?.statusCode || error?.statusCode || null,
    stack: error?.stack ? String(error.stack).split('\n').slice(0, 5).join('\n') : null
  };
}

function requireSecret(req, res, next) {
  const secret = req.headers['x-internal-secret'] || '';
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

function cleanPhone(phone) {
  let cleaned = String(phone || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) cleaned = `62${cleaned.slice(1)}`;
  return cleaned;
}

function normalizeJid(jid) {
  const value = String(jid || '').trim();
  if (!value) return '';
  if (!/@(s\.whatsapp\.net|c\.us|lid|g\.us)$/.test(value)) return '';
  return value.endsWith('@c.us') ? value.replace('@c.us', '@s.whatsapp.net') : value;
}

function buildTargetCandidates({ phone, jid }) {
  const candidates = [];
  const givenJid = normalizeJid(jid);
  if (givenJid) candidates.push(givenJid);
  const cleaned = cleanPhone(phone);
  if (cleaned) candidates.push(`${cleaned}@s.whatsapp.net`);
  return [...new Set(candidates.filter(Boolean))];
}

function phoneFromJid(jid) {
  return String(jid || '').replace(/@(s\.whatsapp\.net|c\.us|lid|g\.us)$/g, '').replace(/[^0-9]/g, '');
}

function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

async function postStatus(deviceId, status, phone = null) {
  writeState(deviceId, { status, phone: phone || null });
  if (!APP_STATUS_URL) return;
  try {
    await axios.post(APP_STATUS_URL, { device_id: deviceId, status, phone }, { headers: { 'X-Internal-Secret': INTERNAL_SECRET }, timeout: 8000 });
  } catch (err) {
    log('status callback failed:', err.response?.data || err.message);
  }
}

async function postIncoming(deviceId, payload) {
  if (!APP_CALLBACK_URL) return;
  try {
    await axios.post(APP_CALLBACK_URL, { device_id: deviceId, ...payload }, { headers: { 'X-Internal-Secret': INTERNAL_SECRET }, timeout: 15000 });
  } catch (err) {
    log('incoming callback failed:', err.response?.data || err.message);
  }
}

async function startSession(deviceId) {
  deviceId = String(deviceId);
  if (sessions.has(deviceId)) return sessions.get(deviceId);

  writeState(deviceId, { status: 'connecting', qr: null, qr_image: null, phone: null });

  const sessionPath = path.join(SESSIONS_DIR, deviceId);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const version = await resolveWaVersion();

  const stateObj = { sock: null, qr: null, qrImage: null, status: 'connecting', phone: null, pid: process.pid };
  sessions.set(deviceId, stateObj);

  log(`[device ${deviceId}] starting session pid=${process.pid} path=${sessionPath}`);

  const logger = P({ level: process.env.BAILEYS_LOG_LEVEL || 'error' });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    qrTimeout: 60000,
    retryRequestDelayMs: 1000,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined
  });
  stateObj.sock = sock;

  if (sock.ws) {
    sock.ws.on('error', (err) => log(`[device ${deviceId}] websocket error:`, err?.message || err));
    sock.ws.on('close', (code, reason) => log(`[device ${deviceId}] websocket close code=${code || '-'} reason=${reason ? reason.toString() : '-'}`));
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      stateObj.qr = qr;
      stateObj.qrImage = await qrcode.toDataURL(qr);
      stateObj.status = 'qr';
      writeState(deviceId, { status: 'qr', qr, qr_image: stateObj.qrImage, phone: null });
      log(`[device ${deviceId}] QR generated pid=${process.pid}`);
      await postStatus(deviceId, 'qr');
    }
    if (connection === 'open') {
      stateObj.status = 'online';
      stateObj.qr = null;
      stateObj.qrImage = null;
      stateObj.phone = sock.user && sock.user.id ? String(sock.user.id).split(':')[0].replace(/[^0-9]/g, '') : null;
      writeState(deviceId, { status: 'online', qr: null, qr_image: null, phone: stateObj.phone });
      log(`[device ${deviceId}] online as ${stateObj.phone || '-'} pid=${process.pid}`);
      await postStatus(deviceId, 'online', stateObj.phone);
    }
    if (connection === 'close') {
      const details = summarizeDisconnect(lastDisconnect?.error);
      const code = details.statusCode;
      stateObj.status = 'offline';
      writeState(deviceId, {
        status: 'offline',
        qr: null,
        qr_image: null,
        phone: null,
        disconnect_code: code,
        disconnect_message: details.message,
        disconnect_stack: details.stack
      });
      log(`[device ${deviceId}] connection closed code=${code || '-'} message=${details.message || '-'} pid=${process.pid}`);
      await postStatus(deviceId, 'offline');
      sessions.delete(deviceId);
      if (AUTO_RECONNECT && code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSession(deviceId).catch((err) => log(`[device ${deviceId}] restart failed:`, err.message)), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const key = msg.key || {};
      const remoteJid = key.remoteJid || '';
      const remoteJidAlt = key.remoteJidAlt || key.remoteJidAlternate || '';
      const senderPn = key.senderPn || key.participantPn || key.participantAlt || '';
      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = key.participant || remoteJid;
      const replyJid = isGroup ? senderJid : (remoteJidAlt || senderPn || remoteJid);
      const phone = phoneFromJid(replyJid || senderJid || remoteJid);
      const text = extractText(msg);

      log(`[device ${deviceId}] incoming from ${phone || '-'} remote=${remoteJid || '-'} reply_jid=${replyJid || '-'} text=${String(text).slice(0, 80)}`);

      await postIncoming(deviceId, {
        phone,
        jid: replyJid,
        reply_jid: replyJid,
        remote_jid: remoteJid,
        remote_jid_alt: remoteJidAlt,
        sender_jid: senderJid,
        sender_pn: senderPn,
        is_group: isGroup,
        message: text,
        raw: msg
      });
    }
  });

  return stateObj;
}

app.get('/', (req, res) => res.json({ success: true, service: 'wa-gateway-node', message: 'Node service is running' }));
app.get('/health', (req, res) => res.json({ success: true, service: 'wa-gateway-node', time: new Date().toISOString(), pid: process.pid, memory_sessions: sessions.size, file_states: stateCount() }));

app.post('/session/start', requireSecret, async (req, res) => {
  try {
    const deviceId = req.body.device_id;
    if (!deviceId) return res.status(422).json({ success: false, message: 'device_id required' });
    const session = await startSession(deviceId);
    const fileState = readState(deviceId);
    res.json({ success: true, status: session.status, pid: process.pid, state: fileState || null });
  } catch (err) {
    log('session/start failed:', err.stack || err.message);
    writeState(req.body?.device_id || 'unknown', { status: 'error', error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/session/:deviceId/qr', requireSecret, async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const session = sessions.get(deviceId);
  if (session) {
    return res.json({ success: true, status: session.status, phone: session.phone, qr: session.qr, qr_image: session.qrImage, pid: process.pid, source: 'memory' });
  }

  const fileState = readState(deviceId);
  if (fileState) {
    return res.json({
      success: true,
      status: fileState.status || 'offline',
      phone: fileState.phone || null,
      qr: fileState.qr || null,
      qr_image: fileState.qr_image || null,
      pid: process.pid,
      source: 'file',
      state_pid: fileState.pid || null,
      updated_at: fileState.updated_at || null
    });
  }

  return res.json({ success: true, status: 'offline', qr: null, qr_image: null, pid: process.pid, source: 'none' });
});

app.post('/send-message', requireSecret, async (req, res) => {
  try {
    const { device_id, phone, message, jid } = req.body;
    if (!device_id || (!phone && !jid) || !message) return res.status(422).json({ success: false, message: 'device_id, phone/jid, message required' });
    const session = sessions.get(String(device_id));
    if (!session || session.status !== 'online' || !session.sock) {
      const fileState = readState(String(device_id));
      return res.status(409).json({
        success: false,
        message: 'Device tidak online di worker Node ini. Restart Node App atau pastikan cPanel hanya menjalankan 1 instance.',
        pid: process.pid,
        state: fileState || null
      });
    }

    const candidates = buildTargetCandidates({ phone, jid });
    if (!candidates.length) return res.status(422).json({ success: false, message: 'Nomor/JID tujuan tidak valid' });

    const errors = [];
    for (const targetJid of candidates) {
      try {
        if (!jid && targetJid.endsWith('@s.whatsapp.net')) {
          const exists = await session.sock.onWhatsApp(targetJid).catch(() => []);
          if (!exists || !exists[0]?.exists) {
            errors.push({ jid: targetJid, message: 'Nomor tujuan tidak terdaftar WhatsApp' });
            continue;
          }
        }

        log(`[device ${device_id}] send to jid=${targetJid} phone=${phone || '-'} message=${String(message).slice(0, 80)}`);
        await session.sock.sendPresenceUpdate('composing', targetJid).catch(() => {});
        let content;
        const messageType = String(req.body.message_type || 'text');
        if (messageType === 'attachment') {
          const attachmentUrl = String(req.body.attachment_url || '');
          const attachmentType = String(req.body.attachment_type || 'document');
          if (!attachmentUrl) throw new Error('attachment_url required');
          if (attachmentType === 'image') content = { image: { url: attachmentUrl }, caption: String(message || '') };
          else if (attachmentType === 'video') content = { video: { url: attachmentUrl }, caption: String(message || '') };
          else content = { document: { url: attachmentUrl }, fileName: attachmentUrl.split('/').pop() || 'document', caption: String(message || '') };
        } else if (messageType === 'location') {
          const lat = Number(req.body.latitude || 0);
          const lng = Number(req.body.longitude || 0);
          if (!lat || !lng) throw new Error('latitude and longitude required');
          content = { location: { degreesLatitude: lat, degreesLongitude: lng, name: String(req.body.location_name || 'Lokasi') } };
        } else if (messageType === 'button') {
          const buttons = Array.isArray(req.body.buttons) ? req.body.buttons : [];
          const extra = buttons.length ? '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n') : '';
          content = { text: String(message || '') + extra };
        } else {
          content = { text: String(message) };
        }
        const result = await session.sock.sendMessage(targetJid, content);
        await session.sock.sendPresenceUpdate('paused', targetJid).catch(() => {});

        log(`[device ${device_id}] sent message_id=${result?.key?.id || '-'} to=${targetJid}`);
        return res.json({ success: true, message_id: result?.key?.id || null, jid: targetJid, tried: candidates, result });
      } catch (sendErr) {
        log(`[device ${device_id}] send candidate failed ${targetJid}:`, sendErr?.message || sendErr);
        errors.push({ jid: targetJid, message: sendErr?.message || String(sendErr) });
      }
    }

    return res.status(500).json({ success: false, message: 'Semua target kirim gagal', tried: candidates, errors });
  } catch (err) {
    log('send-message failed:', err.stack || err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  log(`WA Gateway Node service running on port ${PORT} pid=${process.pid}`);
});
