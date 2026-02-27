require('dotenv').config();
const express  = require('express');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const axios    = require('axios');
const multer   = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Stores ───────────────────────────────────────────────────────────────────
const jobs         = new Map();
const sseClients   = new Map();
const callIndex    = new Map();
const smsSent      = new Set();
const conversations = new Map(); // phone → [{direction:'out'|'in', body, timestamp}]
const phoneToJob    = new Map(); // formatted-phone → {jobId, leadIndex}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(jobId, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  (sseClients.get(jobId) || []).forEach(r => { try { r.write(msg); } catch (_) {} });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatPhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length > 11) return `+1${d.slice(-10)}`;
  return `+1${d}`;
}

function classifyOutcome(call) {
  const reason  = (call.endedReason  || '').toLowerCase();
  const summary = (call.analysis?.summary || '').toLowerCase();
  if (['customer-did-not-answer','no-answer','voicemail'].some(r => reason.includes(r))) return 'no-answer';
  if (['do-not-call','rejected'].some(r => reason.includes(r))) return 'not-interested';
  if (reason.includes('hang-up') && !call.startedAt) return 'not-interested';
  if (['book','schedul','appoint','interested','call back','set up','yes'].some(w => summary.includes(w))) return 'hot';
  if (['maybe','follow','later','think about','consider','down the road'].some(w => summary.includes(w))) return 'warm';
  if (reason.includes('ended-call')) return 'completed';
  return 'completed';
}

// ─── Classify SMS reply ───────────────────────────────────────────────────────
function classifyReply(body) {
  const b = (body || '').toLowerCase();
  if (/\b(yes|sure|interested|how much|make an offer|absolutely|definitely|open to it|call me|love to|sounds good|let'?s talk|go ahead|please|why not)\b/.test(b)) return 'hot';
  if (/\b(maybe|not sure|think about|sometime|later|possibly|depends)\b/.test(b)) return 'warm';
  if (/\b(no\b|stop|remove|unsubscribe|not interested|opt out|don'?t contact|wrong number|leave me alone)\b/.test(b)) return 'not-interested';
  return 'replied';
}

// ─── Twilio SMS ───────────────────────────────────────────────────────────────
function getTwilio() {
  return require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) return;
  try { await getTwilio().messages.create({ from: process.env.TWILIO_FROM, to, body }); } catch (_) {}
}

async function sendHotLeadSMS(lead, summary, duration) {
  const name = lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unknown';
  const dur  = duration && duration !== '—' ? ` (${duration} call)` : '';
  await sendSMS(process.env.TWILIO_TO, [
    `🔥 HOT LEAD${dur}`,
    ``,
    `👤 ${name}`,
    `📞 ${lead.phone}`,
    ``,
    `Sarah's summary:`,
    (summary || '').substring(0, 300),
    ``,
    `Call them back ASAP!`
  ].join('\n'));
}

// ─── Probe text → filter disconnected numbers ─────────────────────────────────
async function probeAndFilter(leads) {
  if (!process.env.TWILIO_ACCOUNT_SID) return leads; // skip if no Twilio
  const twilio = getTwilio();

  console.log(`  📨 Sending probe texts to ${leads.length} numbers...`);

  const probed = await Promise.allSettled(leads.map(async lead => {
    const phone = formatPhone(lead.phone);
    const name  = lead.firstName || 'there';
    const msg   = await twilio.messages.create({
      from: process.env.TWILIO_FROM,
      to:   phone,
      body: `Hi ${name}, this is Omar from Rad Realty — I'll be giving you a quick call shortly!`
    });
    return { lead, sid: msg.sid };
  }));

  // Wait for delivery receipts
  await sleep(12000);

  const valid = [];
  for (const result of probed) {
    if (result.status !== 'fulfilled') continue;
    const { lead, sid } = result.value;
    try {
      const msg = await twilio.messages(sid).fetch();
      if (!['failed', 'undelivered'].includes(msg.status)) valid.push(lead);
      else console.log(`  ✗ Dropped ${lead.phone} — ${msg.status}`);
    } catch (_) {
      valid.push(lead); // assume valid if we can't check
    }
  }

  console.log(`  ✓ ${valid.length}/${leads.length} numbers valid after probe`);
  return valid;
}

// ─── Email report ─────────────────────────────────────────────────────────────
async function sendEmailReport(results, total) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || !process.env.EMAIL_TO) return;
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    const hot       = results.filter(r => r.outcome === 'hot');
    const warm      = results.filter(r => r.outcome === 'warm');
    const noAnswer  = results.filter(r => r.outcome === 'no-answer');
    const notInt    = results.filter(r => r.outcome === 'not-interested');
    const completed = results.filter(r => r.outcome === 'completed');
    const errors    = results.filter(r => r.outcome === 'error' || r.status === 'error');

    const outcomeRow = (label, color, items) => items.length === 0 ? '' : `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;">
          <span style="background:${color}22;color:${color};padding:3px 10px;border-radius:100px;font-size:12px;font-weight:600;">${label}</span>
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;font-weight:700;font-size:18px;color:#eef2ff;">${items.length}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;color:#8899bb;font-size:13px;">
          ${items.map(r => r.name || r.phone).join(', ')}
        </td>
      </tr>`;

    const callRows = results.map(r => {
      const color = {hot:'#f97316',warm:'#eab308',completed:'#22c55e','no-answer':'#64748b','not-interested':'#f04a4a',error:'#f04a4a'}[r.outcome] || '#64748b';
      return `<tr>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;color:#eef2ff;font-weight:500;">${r.name || '—'}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;color:#8899bb;">${r.phone || '—'}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;">
          <span style="background:${color}22;color:${color};padding:3px 10px;border-radius:100px;font-size:11px;font-weight:600;">${r.outcome || r.status}</span>
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;color:#8899bb;font-size:12px;">${r.duration || '—'}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #1e2538;color:#8899bb;font-size:12px;max-width:300px;">${(r.summary || '—').substring(0,150)}</td>
      </tr>`;
    }).join('');

    const html = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"></head>
    <body style="background:#080c18;font-family:Inter,sans-serif;padding:32px;color:#eef2ff;">
      <div style="max-width:800px;margin:0 auto;">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:32px;">
          <div style="width:46px;height:46px;background:linear-gradient(135deg,#d4a534,#b88e28);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;">📞</div>
          <div>
            <div style="font-size:20px;font-weight:700;">Sarah AI Caller</div>
            <div style="font-size:13px;color:#8899bb;">Rad Realty — Call Report</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px;">
          ${[
            ['Total',total,'#d4a534'],
            ['🔥 Hot',hot.length,'#f97316'],
            ['⚡ Warm',warm.length,'#eab308'],
            ['✅ Completed',completed.length,'#22c55e'],
          ].map(([l,n,c])=>`
            <div style="background:#0f1424;border:1px solid #1e2538;border-radius:12px;padding:16px;text-align:center;">
              <div style="font-size:28px;font-weight:800;color:${c};">${n}</div>
              <div style="font-size:11px;color:#5c6a8a;font-weight:600;text-transform:uppercase;letter-spacing:.6px;">${l}</div>
            </div>`).join('')}
        </div>

        <div style="background:#0f1424;border:1px solid #1e2538;border-radius:12px;overflow:hidden;margin-bottom:24px;">
          <div style="padding:16px 20px;border-bottom:1px solid #1e2538;font-weight:600;">Summary by Outcome</div>
          <table style="width:100%;border-collapse:collapse;">
            ${outcomeRow('🔥 Hot','#f97316',hot)}
            ${outcomeRow('⚡ Warm','#eab308',warm)}
            ${outcomeRow('✅ Completed','#22c55e',completed)}
            ${outcomeRow('📵 No Answer','#64748b',noAnswer)}
            ${outcomeRow('🚫 Not Interested','#f04a4a',notInt)}
            ${outcomeRow('⚠ Error','#f04a4a',errors)}
          </table>
        </div>

        <div style="background:#0f1424;border:1px solid #1e2538;border-radius:12px;overflow:hidden;">
          <div style="padding:16px 20px;border-bottom:1px solid #1e2538;font-weight:600;">All Calls</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#080c18;">
                <th style="padding:10px 16px;text-align:left;font-size:11px;color:#5c6a8a;text-transform:uppercase;letter-spacing:.5px;">Name</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;color:#5c6a8a;text-transform:uppercase;letter-spacing:.5px;">Phone</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;color:#5c6a8a;text-transform:uppercase;letter-spacing:.5px;">Outcome</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;color:#5c6a8a;text-transform:uppercase;letter-spacing:.5px;">Duration</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;color:#5c6a8a;text-transform:uppercase;letter-spacing:.5px;">Summary</th>
              </tr>
            </thead>
            <tbody>${callRows}</tbody>
          </table>
        </div>

        <div style="margin-top:24px;text-align:center;color:#5c6a8a;font-size:12px;">
          Generated by Sarah AI Caller — Rad Realty
        </div>
      </div>
    </body></html>`;

    await transporter.sendMail({
      from:    `"Sarah AI Caller" <${process.env.EMAIL_USER}>`,
      to:      process.env.EMAIL_TO,
      subject: `📊 Call Report — ${total} leads called by Sarah (${hot.length} hot, ${warm.length} warm)`,
      html
    });
    console.log('  ✉ Email report sent to', process.env.EMAIL_TO);
  } catch (e) {
    console.log('  ✗ Email report failed:', e.message);
  }
}

// ─── Initiate a single VAPI call ──────────────────────────────────────────────
async function initiateCall(lead) {
  const phone = formatPhone(lead.phone);
  const res = await axios.post('https://api.vapi.ai/call', {
    assistantId: process.env.VAPI_ASSISTANT_ID,
    assistantOverrides: {
      variableValues: {
        first_name:       lead.firstName || lead.name || 'there',
        street_name:      lead.streetName || lead.city || '',
        property_address: lead.streetName || lead.city || '',
        property_value:   lead.propertyValue || '',
        phone_number:     phone,
      }
    },
    customer:      { name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Lead', number: phone },
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID
  }, {
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    timeout: 30000
  });
  return res.data?.id;
}

// ─── Schedule retry for no-answer ────────────────────────────────────────────
function scheduleRetry(info) {
  const delayMs = parseInt(process.env.RETRY_DELAY_MINUTES || '45') * 60 * 1000;
  setTimeout(async () => {
    try {
      const newCallId = await initiateCall(info.lead);
      callIndex.set(newCallId, { ...info, retries: info.retries + 1 });
      const job = jobs.get(info.jobId);
      if (job?.results[info.leadIndex]) {
        job.results[info.leadIndex].status  = 'initiated';
        job.results[info.leadIndex].callId  = newCallId;
        job.results[info.leadIndex].retried = true;
      }
      console.log(`  ↻ Retry initiated for ${info.lead.name}: ${newCallId}`);
    } catch (err) {
      console.log(`  ✗ Retry failed for ${info.lead.name}: ${err.message}`);
    }
  }, delayMs);
}

// ─── Core: process SMS blast job ─────────────────────────────────────────────
async function processSMSJob(jobId, leads) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';

  const template = job.messageTemplate ||
    `Hi {name}! This is Sarah from Rad Realty 🏠 We buy homes in your area for cash — fast closings, no repairs needed. Would you be open to a quick chat? Just reply back!`;

  for (let i = 0; i < leads.length; i++) {
    if (!jobs.has(jobId)) break;

    const lead     = leads[i];
    const phone    = formatPhone(lead.phone);
    const name     = lead.firstName || 'there';
    const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.name || '';
    lead.name      = leadName;

    job.results[i] = { ...lead, name: leadName, phone, status: 'sending' };
    broadcast(jobId, { type: 'update', index: i, result: job.results[i], progress: { current: i, total: leads.length } });

    try {
      const body = template.replace(/\{name\}/gi, name).replace(/\{first_name\}/gi, name);
      await getTwilio().messages.create({ from: process.env.TWILIO_FROM, to: phone, body });

      if (!conversations.has(phone)) conversations.set(phone, []);
      conversations.get(phone).push({ direction: 'out', body, timestamp: new Date().toISOString() });
      phoneToJob.set(phone, { jobId, leadIndex: i });

      job.results[i] = { ...lead, name: leadName, phone, status: 'sent', sentAt: new Date().toISOString(), outcome: 'sent' };
    } catch (err) {
      job.results[i] = { ...lead, name: leadName, phone, status: 'error', error: err.message, outcome: 'error' };
    }

    broadcast(jobId, { type: 'update', index: i, result: job.results[i], progress: { current: i + 1, total: leads.length } });
    if (i < leads.length - 1) await sleep(parseInt(process.env.CALL_DELAY_MS || '1500'));
  }

  job.status = 'complete';
  const sent   = job.results.filter(r => r.status === 'sent').length;
  const errors = job.results.filter(r => r.status === 'error').length;
  broadcast(jobId, { type: 'complete', sent, errors, total: leads.length });
  (sseClients.get(jobId) || []).forEach(r => { try { r.end(); } catch (_) {} });
  sseClients.delete(jobId);

  await sendSMS(process.env.TWILIO_TO,
    `✅ Sarah texted ${sent} leads for Rad Realty.\n${errors} failed.\nYou'll get an alert every time someone replies!`
  );
}

// ─── Core: process job ────────────────────────────────────────────────────────
async function processJob(jobId, leads, useProbe) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';

  // Optional probe text filter
  let callLeads = leads;
  if (useProbe) {
    broadcast(jobId, { type: 'probe', message: `Sending probe texts to ${leads.length} numbers...` });
    callLeads = await probeAndFilter(leads);
    broadcast(jobId, { type: 'probe_done', valid: callLeads.length, dropped: leads.length - callLeads.length });
  }

  for (let i = 0; i < callLeads.length; i++) {
    if (!jobs.has(jobId)) break;

    const lead     = callLeads[i];
    const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.name || '';
    lead.name      = leadName;

    job.results[i] = { ...lead, name: leadName, status: 'calling' };
    broadcast(jobId, { type: 'update', index: i, result: job.results[i], progress: { current: i, total: callLeads.length } });

    try {
      const callId = await initiateCall(lead);
      job.results[i] = { ...lead, name: leadName, status: 'initiated', callId, phone: formatPhone(lead.phone) };
      callIndex.set(callId, { jobId, leadIndex: i, lead: { ...lead, name: leadName }, retries: 0 });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      job.results[i] = { ...lead, name: leadName, status: 'error', error: errMsg, phone: formatPhone(lead.phone) };
    }

    broadcast(jobId, { type: 'update', index: i, result: job.results[i], progress: { current: i + 1, total: callLeads.length } });
    if (i < callLeads.length - 1) await sleep(parseInt(process.env.CALL_DELAY_MS || '1500'));
  }

  job.status = 'complete';
  const initiated = job.results.filter(r => r.status === 'initiated').length;
  const errors    = job.results.filter(r => r.status === 'error').length;
  broadcast(jobId, { type: 'complete', initiated, errors, total: callLeads.length });
  (sseClients.get(jobId) || []).forEach(r => { try { r.end(); } catch (_) {} });
  sseClients.delete(jobId);

  await sendSMS(process.env.TWILIO_TO,
    `✅ Sarah finished calling ${callLeads.length} leads for Rad Realty.\n${initiated} calls initiated, ${errors} errors.\nCheck your dashboard for hot leads!`
  );
}

// ─── POST /api/parse-pdf ──────────────────────────────────────────────────────
app.post('/api/parse-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const pdfParse = require('pdf-parse');
    const data     = await pdfParse(req.file.buffer);
    const text     = data.text;

    // Extract all phone-number-like strings
    const phoneRegex = /(\+?1?\s?[\-.]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
    const raw = text.match(phoneRegex) || [];
    const phones = [...new Set(
      raw.map(p => p.replace(/\D/g, '')).filter(d => d.length >= 10).map(d => d.slice(-10))
    )];

    res.json({ phones, total: phones.length, pages: data.numpages });
  } catch (e) {
    res.status(500).json({ error: 'Failed to parse PDF: ' + e.message });
  }
});

// ─── POST /api/launch ────────────────────────────────────────────────────────
app.post('/api/launch', (req, res) => {
  const { rows, mapping, limit, useProbe = false, mode = 'call', messageTemplate } = req.body;
  if (!rows?.length || !mapping) return res.status(400).json({ error: 'Missing rows or mapping.' });

  if (mode === 'call') {
    const missing = ['VAPI_API_KEY','VAPI_ASSISTANT_ID','VAPI_PHONE_NUMBER_ID'].find(k => !process.env[k]);
    if (missing) return res.status(500).json({ error: `${missing} not configured.` });
  }
  if (!process.env.TWILIO_ACCOUNT_SID) return res.status(500).json({ error: 'TWILIO_ACCOUNT_SID not configured.' });

  // No hard limit — use what the user specifies, or all leads
  const cap = limit ? parseInt(limit) : rows.length;

  const leads = rows.slice(0, cap).map(row => ({
    firstName:     String(row[mapping.firstName]     || '').trim(),
    lastName:      String(row[mapping.lastName]      || '').trim(),
    phone:         String(row[mapping.phone]         || '').trim(),
    streetName:    String(row[mapping.streetName]    || '').trim(),
    city:          String(row[mapping.city]          || '').trim(),
    propertyValue: String(row[mapping.propertyValue] || '').trim(),
  })).filter(l => l.phone);

  if (!leads.length) {
    const sample = rows[0] || {};
    return res.status(400).json({
      error: `No leads with phone numbers found. Phone column: "${mapping.phone}", sample value: "${sample[mapping.phone] || 'empty'}"`
    });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    status: 'pending', total: leads.length, mode,
    messageTemplate: messageTemplate || null,
    results: leads.map(l => ({ ...l, status: 'pending' })),
    createdAt: new Date().toISOString()
  });

  if (mode === 'sms') {
    processSMSJob(jobId, leads);
  } else {
    processJob(jobId, leads, useProbe);
  }
  res.json({ jobId, total: leads.length, mode });
});

// ─── POST /api/webhook/vapi ───────────────────────────────────────────────────
app.post('/api/webhook/vapi', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || msg.type !== 'end-of-call-report') return;

  const call    = msg.call;
  const callId  = call?.id;
  if (!callId) return;

  const outcome = classifyOutcome(call);
  const summary = call.analysis?.summary || '';
  const dur     = call.startedAt && call.endedAt
    ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) + 's' : '—';

  console.log(`  📞 ${call.customer?.number} | ${outcome} | ${call.endedReason}`);

  const info = callIndex.get(callId);
  if (info) {
    const job = jobs.get(info.jobId);
    if (job?.results[info.leadIndex]) Object.assign(job.results[info.leadIndex], { outcome, summary, endedReason: call.endedReason, duration: dur });

    if (outcome === 'hot' && !smsSent.has(callId)) {
      smsSent.add(callId);
      await sendHotLeadSMS(info.lead, summary, dur);
    }
    if (outcome === 'no-answer' && info.retries < 1) scheduleRetry(info);

    // Check if all calls in the job are done → send email
    const job2 = jobs.get(info.jobId);
    if (job2 && job2.results.every(r => r.outcome || r.status === 'error')) {
      await sendEmailReport(job2.results, job2.total);
    }
  }
});

// ─── POST /api/webhook/sms — incoming replies from leads ─────────────────────
app.post('/api/webhook/sms', (req, res) => {
  // Respond immediately with empty TwiML so Twilio doesn't complain
  res.setHeader('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  const from = req.body?.From;
  const body = (req.body?.Body || '').trim();
  if (!from || !body) return;

  const timestamp = new Date().toISOString();
  if (!conversations.has(from)) conversations.set(from, []);
  conversations.get(from).push({ direction: 'in', body, timestamp });

  const outcome = classifyReply(body);
  const emojiMap = { hot: '🔥', warm: '⚡', 'not-interested': '🚫', replied: '💬' };

  // Update job result
  const info = phoneToJob.get(from);
  let leadName = from;
  if (info) {
    const job = jobs.get(info.jobId);
    if (job?.results[info.leadIndex]) {
      const r = job.results[info.leadIndex];
      leadName      = r.name || from;
      r.replied     = true;
      r.lastReply   = body;
      r.repliedAt   = timestamp;
      r.outcome     = outcome;
      // Push live update to any open dashboard tabs
      broadcast(info.jobId, { type: 'reply', index: info.leadIndex, result: r });
    }
  }

  // Alert Omar
  sendSMS(process.env.TWILIO_TO,
    `${emojiMap[outcome] || '💬'} Reply from ${leadName}\n📞 ${from}\n\n"${body}"\n\nLog in to see the full dashboard!`
  );
});

// ─── GET /api/conversations/:jobId ───────────────────────────────────────────
app.get('/api/conversations/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const data = job.results.map(r => ({
    ...r,
    thread: conversations.get(r.phone) || []
  }));

  res.json({ conversations: data, mode: job.mode, fetchedAt: new Date().toISOString() });
});

// ─── GET /api/job/:jobId/stream ───────────────────────────────────────────────
app.get('/api/job/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); } }, 15000);

  if (!sseClients.has(req.params.jobId)) sseClients.set(req.params.jobId, []);
  sseClients.get(req.params.jobId).push(res);
  res.write(`data: ${JSON.stringify({ type: 'init', job })}\n\n`);

  if (job.status === 'complete') {
    res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
    res.end(); return;
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(req.params.jobId) || [];
    const idx = clients.indexOf(res);
    if (idx > -1) clients.splice(idx, 1);
  });
});

// ─── GET /api/job/:jobId ──────────────────────────────────────────────────────
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── GET /api/results/:jobId ──────────────────────────────────────────────────
app.get('/api/results/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const initiated = job.results.filter(r => r.callId);
  const settled   = await Promise.allSettled(initiated.map(async r => {
    if (r.outcome) return { name: r.name, phone: r.phone, callId: r.callId, callStatus: 'ended', endedReason: r.endedReason || '—', duration: r.duration || '—', summary: r.summary || '', outcome: r.outcome };
    const { data: c } = await axios.get(`https://api.vapi.ai/call/${r.callId}`, { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` } });
    return { name: r.name, phone: r.phone, callId: r.callId, callStatus: c.status, endedReason: c.endedReason || '—', duration: c.startedAt && c.endedAt ? Math.round((new Date(c.endedAt)-new Date(c.startedAt))/1000)+'s' : '—', summary: c.analysis?.summary || '', outcome: classifyOutcome(c) };
  }));

  const errorRows = job.results.filter(r => !r.callId).map(r => ({ name: r.name, phone: r.phone, callId: null, callStatus: 'error', endedReason: r.error || 'Failed', duration: '—', summary: '', outcome: 'error' }));
  const results   = [ ...settled.map((s,i) => s.status==='fulfilled' ? s.value : { ...initiated[i], outcome:'unknown', summary:'Could not fetch', endedReason: s.reason?.message }), ...errorRows ];

  // Fire hot lead SMS for any missed (local mode)
  for (const r of results) {
    if (r.outcome === 'hot' && r.callId && !smsSent.has(r.callId) && r.summary) {
      smsSent.add(r.callId);
      const info = callIndex.get(r.callId);
      await sendHotLeadSMS(info?.lead || { name: r.name, phone: r.phone }, r.summary, r.duration);
    }
  }

  // Send email report
  await sendEmailReport(results, job.total);

  res.json({ results, fetchedAt: new Date().toISOString() });
});

// ─── GET /api/results/:jobId/csv ──────────────────────────────────────────────
app.get('/api/results/:jobId/csv', async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).send('Job not found');
    const initiated = job.results.filter(r => r.callId);
    const settled   = await Promise.allSettled(initiated.map(async r => {
      if (r.outcome) return { name: r.name, phone: r.phone, outcome: r.outcome, duration: r.duration||'', endedReason: r.endedReason||'', summary: r.summary||'' };
      const { data: c } = await axios.get(`https://api.vapi.ai/call/${r.callId}`, { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` } });
      return { name: r.name, phone: r.phone, outcome: classifyOutcome(c), duration: c.startedAt&&c.endedAt ? Math.round((new Date(c.endedAt)-new Date(c.startedAt))/1000)+'s' : '', endedReason: c.endedReason||'', summary: (c.analysis?.summary||'').replace(/\n/g,' ') };
    }));
    const errorRows = job.results.filter(r => !r.callId).map(r => ({ name: r.name, phone: r.phone, outcome: 'error', duration: '', endedReason: r.error||'', summary: '' }));
    const rows = [ ...settled.map(s => s.status==='fulfilled' ? s.value : { name:'', phone:'', outcome:'unknown', duration:'', endedReason: s.reason?.message||'', summary:'' }), ...errorRows ];
    const csv = ['Name,Phone,Outcome,Duration,Ended Reason,Summary', ...rows.map(r => ['name','phone','outcome','duration','endedReason','summary'].map(k=>`"${String(r[k]||'').replace(/"/g,"'")}"`).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="call-results-${req.params.jobId.slice(0,8)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ─── Auto-register webhook on startup ────────────────────────────────────────
async function setupWebhook() {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) return;
  try {
    await axios.patch(`https://api.vapi.ai/assistant/${process.env.VAPI_ASSISTANT_ID}`, {
      server: { url: `${serverUrl}/api/webhook/vapi` }
    }, { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` } });
    console.log(`  Webhook: ${serverUrl}/api/webhook/vapi`);
  } catch (e) { console.log(`  Webhook setup failed: ${e.message}`); }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`\n  Sarah AI Caller — Rad Realty`);
  console.log(`  Running at: http://localhost:${PORT}`);
  await setupWebhook();
  console.log();
});
