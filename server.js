const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CC_API_KEY = process.env.CC_API_KEY;
const CC_CLIENT_SECRET = process.env.CC_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
const MEMBERSHIP_SHEET_ID = process.env.MEMBERSHIP_SHEET_ID;
const ACADEMY_SHEET_ID = process.env.ACADEMY_SHEET_ID;
const ACADEMY_LIST_ID = '132ca7fe-47cb-11f1-bdf1-02420a320003';

let storedTokens = {
  access_token: '',
  refresh_token: process.env.SAVED_REFRESH_TOKEN || '',
  expires_at: 0
};

function getGoogleAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function ensureSheet(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.map(s => s.properties.title);
  if (!existing.includes(sheetName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }]
      }
    });
  }
}

async function getAcademyListStats(token) {
  try {
    const resp = await fetch(`https://api.cc.email/v3/contact_lists/${ACADEMY_LIST_ID}?include_count=true`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await resp.json();
    const total = data.membership_count || 0;
    const unsub = data.unsubscribe_count || 0;
    return { total, unsub, active: total - unsub };
  } catch(e) {
    console.error('Failed to get academy list stats:', e.message);
    return { total: 0, unsub: 0, active: 0 };
  }
}

async function writeToMembershipSheet(membershipData) {
  if (!MEMBERSHIP_SHEET_ID) return;
  try {
    const auth = await getGoogleAuth().getClient();
    const sheets = google.sheets({ version: 'v4', auth });
    for (const [type, contacts] of Object.entries(membershipData)) {
      await ensureSheet(sheets, MEMBERSHIP_SHEET_ID, type);
      const rows = [
        ['First Name', 'Last Name', 'Email'],
        ...contacts.map(c => [c.firstName || '', c.lastName || '', c.email])
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId: MEMBERSHIP_SHEET_ID,
        range: `'${type}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: rows }
      });
      console.log(`Membership sheet updated: ${type} (${contacts.length} rows)`);
    }
  } catch(e) {
    console.error('Membership sheet write error:', e.message);
  }
}

async function writeToAcademySheet(statsBefore, statsAfter) {
  if (!ACADEMY_SHEET_ID) return;
  try {
    const auth = await getGoogleAuth().getClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureSheet(sheets, ACADEMY_SHEET_ID, 'Sync Log');

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const trueNew = statsAfter.active - statsBefore.active;

    await sheets.spreadsheets.values.update({
      spreadsheetId: ACADEMY_SHEET_ID,
      range: "'Sync Log'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: [['Last Synced', 'Total on List', 'Unsubscribes', 'Active Emails', 'New This Sync']] }
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: ACADEMY_SHEET_ID,
      range: "'Sync Log'!A1",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[now, statsAfter.total, statsAfter.unsub, statsAfter.active, trueNew]] }
    });

    console.log(`Academy sheet updated: ${now}, total=${statsAfter.total}, unsub=${statsAfter.unsub}, active=${statsAfter.active}, new=${trueNew}`);
  } catch(e) {
    console.error('Academy sheet write error:', e.message);
  }
}

async function saveRefreshToken(token) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
  try {
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars/SAVED_REFRESH_TOKEN`, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + RENDER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ value: token })
    });
    console.log('Refresh token saved to Render environment');
  } catch(e) {
    console.error('Failed to save refresh token:', e.message);
  }
}

async function refreshAccessToken() {
  if (!storedTokens.refresh_token) {
    throw new Error('No refresh token available. Please re-authorize.');
  }
  const resp = await fetch('https://authz.constantcontact.com/oauth2/default/v1/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(CC_API_KEY + ':' + CC_CLIENT_SECRET).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: storedTokens.refresh_token
    })
  });
  const data = await resp.json();
  if (data.access_token) {
    storedTokens.access_token = data.access_token;
    storedTokens.refresh_token = data.refresh_token || storedTokens.refresh_token;
    storedTokens.expires_at = Date.now() + (data.expires_in * 1000) - 60000;
    console.log('Token refreshed successfully, expires in', data.expires_in, 'seconds');
    await saveRefreshToken(storedTokens.refresh_token);
  } else {
    throw new Error('Token refresh failed: ' + JSON.stringify(data));
  }
}

async function getValidToken() {
  if (storedTokens.access_token && Date.now() < storedTokens.expires_at) {
    return storedTokens.access_token;
  }
  await refreshAccessToken();
  return storedTokens.access_token;
}

// NEW: Clean auth status endpoint — never throws, always returns JSON
app.get('/auth-status', (req, res) => {
  const hasRefreshToken = !!storedTokens.refresh_token;
  const hasValidToken = !!storedTokens.access_token && Date.now() < storedTokens.expires_at;
  const minutesLeft = hasValidToken ? Math.round((storedTokens.expires_at - Date.now()) / 60000) : 0;

  if (hasValidToken) {
    res.json({ status: 'authorized', minutesLeft, message: `Token valid for ~${minutesLeft} more minutes` });
  } else if (hasRefreshToken) {
    res.json({ status: 'can_refresh', minutesLeft: 0, message: 'Token expired but refresh token available — will auto-refresh on next sync' });
  } else {
    res.json({ status: 'unauthorized', minutesLeft: 0, message: 'Not authorized — click Authorize below' });
  }
});

// NEW: Auth URL endpoint — returns the CC OAuth URL so the frontend can open it
app.get('/auth-url', (req, res) => {
  const url = `https://authz.constantcontact.com/oauth2/default/v1/authorize?client_id=${CC_API_KEY}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=contact_data&state=abc123`;
  res.json({ url });
});

app.get('/token', async (req, res) => {
  try {
    const token = await getValidToken();
    res.json({ access_token: token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/lists', async (req, res) => {
  try {
    const token = await getValidToken();
    const resp = await fetch('https://api.cc.email/v3/contact_lists?include_count=true', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await resp.json();
    const lists = data.lists.map(l => ({ name: l.name, id: l.list_id, count: l.membership_count }));
    res.json(lists);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/import', async (req, res) => {
  try {
    const token = await getValidToken();
    const { contacts, list_id } = req.body;
    console.log('Import - list_id:', list_id, '| contacts:', contacts.length);

    const statsBefore = await getAcademyListStats(token);

    const payload = {
      import_data: contacts.map(c => ({
        email: c.email_address.address,
        first_name: c.first_name || '',
        last_name: c.last_name || ''
      })),
      list_ids: [list_id]
    };
    const resp = await fetch('https://api.cc.email/v3/activities/contacts_json_import', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    console.log('CC response:', resp.status, JSON.stringify(data).substring(0, 200));
    res.status(resp.status).json({ ...data, statsBefore });
  } catch(e) {
    console.error('Import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sync-membership-sheet', async (req, res) => {
  try {
    const { membershipData } = req.body;
    await writeToMembershipSheet(membershipData);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/sync-academy-sheet', async (req, res) => {
  try {
    const { statsBefore } = req.body;
    const token = await getValidToken();

    // Wait a few seconds for CC to process the import
    await new Promise(resolve => setTimeout(resolve, 5000));

    const statsAfter = await getAcademyListStats(token);
    await writeToAcademySheet(statsBefore, statsAfter);
    res.json({ success: true, statsBefore, statsAfter, trueNew: statsAfter.active - statsBefore.active });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');
  try {
    const resp = await fetch('https://authz.constantcontact.com/oauth2/default/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(CC_API_KEY + ':' + CC_CLIENT_SECRET).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });
    const data = await resp.json();
    if (data.access_token) {
      storedTokens.access_token = data.access_token;
      storedTokens.refresh_token = data.refresh_token;
      storedTokens.expires_at = Date.now() + (data.expires_in * 1000) - 60000;
      console.log('Authorization successful. Token expires in', data.expires_in, 'seconds');
      await saveRefreshToken(data.refresh_token);
      // Close the tab automatically after success
      res.send(`
        <html><head><title>Authorized</title></head>
        <body style="font-family:system-ui;text-align:center;padding:60px;background:#f5f5f3">
          <div style="max-width:400px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;border:1px solid #e5e5e0">
            <div style="font-size:48px;margin-bottom:16px">✅</div>
            <h2 style="font-weight:500;margin-bottom:8px">Authorization successful!</h2>
            <p style="color:#666;font-size:14px">The backend is now connected to Constant Contact.<br>You can close this tab.</p>
            <script>setTimeout(() => window.close(), 2000);<\/script>
          </div>
        </body></html>
      `);
    } else {
      console.error('Auth failed:', JSON.stringify(data));
      res.status(500).send('<h2>Authorization failed</h2><pre>' + JSON.stringify(data, null, 2) + '</pre>');
    }
  } catch(e) {
    res.status(500).send('<h2>Error</h2><pre>' + e.message + '</pre>');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', authorized: !!storedTokens.access_token && Date.now() < storedTokens.expires_at }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
