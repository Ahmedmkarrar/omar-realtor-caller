require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Stores ──────────────────────────────────────────────────────────────────
const jobs       = new Map(); // jobId  → job
const sseClients = new Map(); // jobId  → [res, ...]
const callIndex  = new Map(); // callId → { jobId, leadIndex, lead, retries }

// ─── Helpers ─────────────────────────────────────────────────────────────────
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
  if (d.length > 11) return `+1${d.slice(-10)}`; // strip country code junk
  return `+1${d}`;
}

function classifyOutcome(call) {
  const reason  = (call.endedReason  || '').toLowerCase();
  const summary = (call.analysis?.summary || '').toLowerCase();
  if (['customer-did-not-answer', 'no-answer', 'voicemail'].some(r => reason.includes(r))) return 'no-answer';
  if (['do-not-call', 'rejected'].some(r => reason.includes(r))) return 'not-interested';
  if (reason.includes('hang-up') && !call.startedAt) return 'not-interested';
  if (['book', 'schedul', 'appoint', 'interested', 'call back', 'set up', 'yes'].some(w => summary.includes(w))) return 'hot';
  if (['maybe', 'follow', 'later', 'think about', 'consider', 'down the road'].some(w => summary.includes(w))) return 'warm';
  if (reason.includes('ended-call')) return 'completed';
  return 'completed';
}

// ─── Twilio SMS ───────────────────────────────────────────────────────────────
async function sendSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({ from: process.env.TWILIO_FROM, to, body });
  } catch (_) {}
}

async function sendHotLeadSMS(lead, summary, duration) {
  const name  = lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  const phone = lead.phone || '';
  const dur   = duration && duration !== '—' ? ` (${duration} call)` : '';
  const msg = [
    `🔥 HOT LEAD${dur}`,
    ``,
    `👤 ${name}`,
    `📞 ${phone}`,
    ``,
    `Sarah's summary:`,
    summary.substring(0, 300),
    ``,
    `Call them back ASAP — they're ready to talk!`
  ].join('\n');
  await sendSMS(process.env.TWILIO_TO, msg);
}

// Track which callIds have already had an SMS sent to avoid duplicates
const smsSent = new Set();

// ─── Initiate a single VAPI call ──────────────────────────────────────────────
async function initiateCall(lead) {
  const phone = formatPhone(lead.phone);
  const res = await axios.post(
    'https://api.vapi.ai/call',
    {
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
      customer:      { name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' '), number: phone },
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID
    },
    { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }, timeout: 30000 }
  );
  return res.data?.id;
}

// ─── Schedule a retry for no-answer leads ────────────────────────────────────
function scheduleRetry(info, originalCallId) {
  const delayMs = parseInt(process.env.RETRY_DELAY_MINUTES || '45') * 60 * 1000;
  console.log(`  ↻ Retry scheduled for ${info.lead.name} in ${delayMs / 60000} min`);

  setTimeout(async () => {
    try {
      const newCallId = await initiateCall(info.lead);
      callIndex.set(newCallId, { ...info, retries: info.retries + 1 });

      // Update job result with retry info
      const job = jobs.get(info.jobId);
      if (job?.results[info.leadIndex]) {
        job.results[info.leadIndex].status  = 'initiated';
        job.results[info.leadIndex].callId  = newCallId;
        job.results[info.leadIndex].retried = true;
      }
      console.log(`  ✓ Retry call initiated for ${info.lead.name}: ${newCallId}`);
    } catch (err) {
      console.log(`  ✗ Retry failed for ${info.lead.name}: ${err.message}`);
    }
  }, delayMs);
}

// ─── Core: process job ────────────────────────────────────────────────────────
async function processJob(jobId, leads) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';

  for (let i = 0; i < leads.length; i++) {
    if (!jobs.has(jobId)) break;

    const lead     = leads[i];
    const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
    lead.name      = leadName;

    job.results[i] = { ...lead, name: leadName, status: 'calling' };
    broadcast(jobId, { type: 'update', index: i, result: job.results[i], progress: { current: i, total: leads.length } });

    try {
      const callId = await initiateCall(lead);
      job.results[i] = { ...lead, name: leadName, status: 'initiated', callId, phone: formatPhone(lead.phone) };

      // Register in callIndex for webhook lookup
      callIndex.set(callId, { jobId, leadIndex: i, lead: { ...lead, name: leadName }, retries: 0 });

    } catch (err) {
      const errMsg = err.response?.data?.message || err.response?.data?.error || err.message || 'Unknown error';
      job.results[i] = { ...lead, name: leadName, status: 'error', error: errMsg, phone: formatPhone(lead.phone) };
    }

    broadcast(jobId, { type: 'update', index: i, result: job.results[i], progress: { current: i + 1, total: leads.length } });

    if (i < leads.length - 1) await sleep(parseInt(process.env.CALL_DELAY_MS || '1500'));
  }

  job.status = 'complete';
  const initiated = job.results.filter(r => r.status === 'initiated').length;
  const errors    = job.results.filter(r => r.status === 'error').length;
  broadcast(jobId, { type: 'complete', initiated, errors, total: leads.length });

  (sseClients.get(jobId) || []).forEach(r => { try { r.end(); } catch (_) {} });
  sseClients.delete(jobId);

  // Completion SMS
  await sendSMS(process.env.TWILIO_TO,
    `✅ Sarah finished calling ${leads.length} leads for Rad Realty.\n${initiated} calls initiated, ${errors} errors.\nCheck your dashboard for hot leads!`
  );
}

// ─── POST /api/webhook/vapi  (VAPI calls this when each call ends) ─────────────
app.post('/api/webhook/vapi', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const msg = req.body?.message;
  if (!msg || msg.type !== 'end-of-call-report') return;

  const call   = msg.call;
  const callId = call?.id;
  if (!callId) return;

  const outcome = classifyOutcome(call);
  const summary = call.analysis?.summary || '';

  console.log(`  📞 Call ended: ${call.customer?.number} | ${outcome} | ${call.endedReason}`);

  const info = callIndex.get(callId);
  if (info) {
    // Update stored job result with live outcome data
    const job = jobs.get(info.jobId);
    if (job?.results[info.leadIndex]) {
      Object.assign(job.results[info.leadIndex], {
        outcome,
        summary,
        endedReason: call.endedReason,
        duration: call.startedAt && call.endedAt
          ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) + 's'
          : '—'
      });
    }

    // 🔥 Hot lead → instant SMS to Omar (dedup with smsSent)
    if (outcome === 'hot' && !smsSent.has(callId)) {
      smsSent.add(callId);
      const dur = call.startedAt && call.endedAt
        ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) + 's'
        : '—';
      console.log(`  🔥 HOT LEAD: ${info.lead.name} — sending SMS`);
      await sendHotLeadSMS(info.lead, summary, dur);
    }

    // 🔄 No answer → schedule a retry (max 1 retry per lead)
    if (outcome === 'no-answer' && info.retries < 1) {
      scheduleRetry(info, callId);
    }
  }
});

// ─── POST /api/launch ────────────────────────────────────────────────────────
app.post('/api/launch', (req, res) => {
  const { rows, mapping, limit = 80 } = req.body;
  if (!rows?.length || !mapping) return res.status(400).json({ error: 'Missing rows or column mapping.' });

  const missing = ['VAPI_API_KEY', 'VAPI_ASSISTANT_ID', 'VAPI_PHONE_NUMBER_ID'].find(k => !process.env[k]);
  if (missing) return res.status(500).json({ error: `${missing} is not configured in .env` });

  const leads = rows.slice(0, limit).map(row => ({
    firstName:     String(row[mapping.firstName]     || '').trim(),
    lastName:      String(row[mapping.lastName]      || '').trim(),
    phone:         String(row[mapping.phone]         || '').trim(),
    streetName:    String(row[mapping.streetName]    || '').trim(),
    city:          String(row[mapping.city]          || '').trim(),
    propertyValue: String(row[mapping.propertyValue] || '').trim(),
  })).filter(l => l.phone);

  if (!leads.length) {
    const sample = rows[0] || {};
    const phoneVal = mapping.phone ? sample[mapping.phone] : 'no column mapped';
    return res.status(400).json({
      error: `No leads with phone numbers found. Phone column mapped to "${mapping.phone}", sample value: "${phoneVal}". Check your column mapping.`
    });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    status: 'pending',
    total: leads.length,
    results: leads.map(l => ({ ...l, status: 'pending' })),
    createdAt: new Date().toISOString()
  });

  processJob(jobId, leads);
  res.json({ jobId, total: leads.length });
});

// ─── GET /api/job/:jobId/stream  (SSE) ───────────────────────────────────────
app.get('/api/job/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering on Railway
  res.flushHeaders();

  // Heartbeat every 15s to keep proxy connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 15000);

  if (!sseClients.has(req.params.jobId)) sseClients.set(req.params.jobId, []);
  sseClients.get(req.params.jobId).push(res);
  res.write(`data: ${JSON.stringify({ type: 'init', job })}\n\n`);

  if (job.status === 'complete') {
    res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
    res.end();
    return;
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
  const settled   = await Promise.allSettled(
    initiated.map(async r => {
      // If we already have live outcome from webhook, use it
      if (r.outcome) return { name: r.name, phone: r.phone, callId: r.callId, callStatus: 'ended', endedReason: r.endedReason || '—', duration: r.duration || '—', summary: r.summary || '', outcome: r.outcome };

      // Otherwise fetch from VAPI
      const { data: c } = await axios.get(`https://api.vapi.ai/call/${r.callId}`, {
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
      });
      return {
        name:        r.name,
        phone:       r.phone,
        callId:      r.callId,
        callStatus:  c.status,
        endedReason: c.endedReason || '—',
        duration:    c.startedAt && c.endedAt ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 1000) + 's' : '—',
        summary:     c.analysis?.summary || '',
        outcome:     classifyOutcome(c),
      };
    })
  );

  const errorRows = job.results.filter(r => !r.callId).map(r => ({
    name: r.name, phone: r.phone, callId: null, callStatus: 'error',
    endedReason: r.error || 'Failed to initiate', duration: '—', summary: '', outcome: 'error',
  }));

  const results = [
    ...settled.map((s, i) => s.status === 'fulfilled' ? s.value : { ...initiated[i], outcome: 'unknown', summary: 'Could not fetch', endedReason: s.reason?.message }),
    ...errorRows
  ];

  // Fire hot lead SMS for any hot leads not already alerted (catches locally-run jobs)
  for (const r of results) {
    if (r.outcome === 'hot' && r.callId && !smsSent.has(r.callId) && r.summary) {
      smsSent.add(r.callId);
      const info = callIndex.get(r.callId);
      const lead = info?.lead || { name: r.name, phone: r.phone };
      console.log(`  🔥 HOT LEAD (from fetch): ${r.name} — sending SMS`);
      await sendHotLeadSMS(lead, r.summary, r.duration);
    }
  }

  res.json({ results, fetchedAt: new Date().toISOString() });
});

// ─── GET /api/results/:jobId/csv ──────────────────────────────────────────────
app.get('/api/results/:jobId/csv', async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).send('Job not found');

    const initiated = job.results.filter(r => r.callId);
    const settled   = await Promise.allSettled(
      initiated.map(async r => {
        if (r.outcome) return { name: r.name, phone: r.phone, outcome: r.outcome, duration: r.duration || '', endedReason: r.endedReason || '', summary: r.summary || '' };
        const { data: c } = await axios.get(`https://api.vapi.ai/call/${r.callId}`, {
          headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
        });
        return { name: r.name, phone: r.phone, outcome: classifyOutcome(c),
          duration: c.startedAt && c.endedAt ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 1000) + 's' : '',
          endedReason: c.endedReason || '', summary: (c.analysis?.summary || '').replace(/\n/g, ' ') };
      })
    );

    const errorRows = job.results.filter(r => !r.callId).map(r => ({
      name: r.name, phone: r.phone, outcome: 'error', duration: '', endedReason: r.error || '', summary: ''
    }));

    const rows = [
      ...settled.map(s => s.status === 'fulfilled' ? s.value : { name: '', phone: '', outcome: 'unknown', duration: '', endedReason: s.reason?.message || '', summary: '' }),
      ...errorRows
    ];

    const csv = [
      'Name,Phone,Outcome,Duration,Ended Reason,Summary',
      ...rows.map(r => ['name','phone','outcome','duration','endedReason','summary'].map(k => `"${String(r[k]||'').replace(/"/g,"'")}"` ).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="call-results-${req.params.jobId.slice(0,8)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).send('Error generating CSV: ' + e.message);
  }
});

// ─── Auto-register webhook with VAPI on startup ───────────────────────────────
async function setupWebhook() {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) return;
  try {
    await axios.patch(`https://api.vapi.ai/assistant/${process.env.VAPI_ASSISTANT_ID}`, {
      server: { url: `${serverUrl}/api/webhook/vapi` }
    }, { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` } });
    console.log(`  Webhook registered: ${serverUrl}/api/webhook/vapi`);
  } catch (e) {
    console.log(`  Webhook setup failed: ${e.response?.data?.message || e.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`\n  Sarah AI Caller — Rad Realty`);
  console.log(`  Running at: http://localhost:${PORT}`);
  await setupWebhook();
  console.log();
});
