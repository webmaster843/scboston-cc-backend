const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, 'public')));

const CC_API_KEY = process.env.CC_API_KEY;
const CC_CLIENT_SECRET = process.env.CC_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
const MEMBERSHIP_SHEET_ID = process.env.MEMBERSHIP_SHEET_ID;
const ACADEMY_SHEET_ID = process.env.ACADEMY_SHEET_ID;
const ACADEMY_LIST_ID = '132ca7fe-47cb-11f1-bdf1-02420a320003';
const PROGRAMS_SHEET_ID = process.env.PROGRAMS_SHEET_ID;

// Extensible subcategory config — add new entries here without touching any other code
const PROGRAMS_SUBCATEGORIES = {
  "Programs": [
    "Hockey Power Skating",
    "Theatrical Skating",
    "Adult Skating",
  ],
  "Shows": [
    "A Night of Stars",
    "Ice Chips",
    "Summer Sizzler",
    "Stars on Ice",
    "Meet and Greet Type Opportunities",
  ],
  "Singles / Pairs / Ice Dance / Synchronized Skating": [
    "Synchronized Skating",
    "2016 Worlds",
    "2022 Skate America",
    "2025 Worlds",
    "Qualifying and Non-Qualifying Events",
  ],
  "Other": [
    "General Interest List",
    "Hospitality List",
  ],
};

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

async function writeToMembershipSheet(membershipData, unsubEmails = []) {
  if (!MEMBERSHIP_SHEET_ID) return;
  const unsubSet = new Set(unsubEmails.map(e => e.toLowerCase().trim()));
  try {
    const auth = await getGoogleAuth().getClient();
    const sheets = google.sheets({ version: 'v4', auth });
    for (const [type, contacts] of Object.entries(membershipData)) {
      await ensureSheet(sheets, MEMBERSHIP_SHEET_ID, type);

      // Build A:D membership data
      const rows = [
        ['First Name', 'Last Name', 'Email', 'Zip Code'],
        ...contacts.map(c => [c.firstName || '', c.lastName || '', c.email, c.zip || ''])
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId: MEMBERSHIP_SHEET_ID,
        range: `'${type}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: rows }
      });

      // Build col E: header + any emails from this tab that are in the unsubscribe list
      const tabEmails = contacts.map(c => (c.email || '').toLowerCase().trim());
      const flagged = tabEmails.filter(e => e && unsubSet.has(e));
      const eRows = [['Unsubscribe List'], ...flagged.map(e => [e])];

      // Clear col E fully first, then write fresh data
      const clearEnd = Math.max(contacts.length + 1, 2);
      await sheets.spreadsheets.values.clear({
        spreadsheetId: MEMBERSHIP_SHEET_ID,
        range: `'${type}'!E1:E${clearEnd}`
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: MEMBERSHIP_SHEET_ID,
        range: `'${type}'!E1`,
        valueInputOption: 'RAW',
        requestBody: { values: eRows }
      });

      console.log(`Membership sheet updated: ${type} (${contacts.length} rows, ${flagged.length} unsubscribes flagged)`);
    }
  } catch(e) {
    console.error('Membership sheet write error:', e.message);
  }
}

async function fetchAllUnsubscribes(token) {
  const emails = new Set();
  let cursor = null;
  let page = 0;
  try {
    do {
      const url = cursor
        ? `https://api.cc.email/v3/contacts?status=unsubscribed&limit=500&cursor=${cursor}`
        : `https://api.cc.email/v3/contacts?status=unsubscribed&limit=500`;
      const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json();
      (data.contacts || []).forEach(c => {
        const addr = c.email_address && c.email_address.address;
        if (addr) emails.add(addr.toLowerCase().trim());
      });
      cursor = data._links && data._links.next
        ? new URL('https://api.cc.email' + data._links.next.href).searchParams.get('cursor')
        : null;
      page++;
    } while (cursor && page < 50); // safety cap at 25,000 contacts
    console.log(`Fetched ${emails.size} unsubscribed emails from CC`);
  } catch(e) {
    console.error('Failed to fetch unsubscribes:', e.message);
  }
  return emails;
}

async function readBounceList(sheets) {
  const emails = new Set();
  try {
    await ensureSheet(sheets, ACADEMY_SHEET_ID, 'BOUNCE_LIST');
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: ACADEMY_SHEET_ID,
      range: "'BOUNCE_LIST'!A:A"
    });
    const rows = resp.data.values || [];
    rows.forEach(r => {
      const val = (r[0] || '').trim().toLowerCase();
      if (val && val.includes('@') && val !== 'email') emails.add(val);
    });
    console.log(`Read ${emails.size} bounced emails from BOUNCE_LIST sheet`);
  } catch(e) {
    console.error('Failed to read BOUNCE_LIST:', e.message);
  }
  return emails;
}

// ── zipMap: email -> zip string (optional, may be empty object)
async function updateMasterList(sheets, emailsSynced, unsubSet, bounceSet, zipMap) {
  zipMap = zipMap || {};
  await ensureSheet(sheets, ACADEMY_SHEET_ID, 'MASTER_LIST');
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });

  // Read existing master list
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: ACADEMY_SHEET_ID,
    range: "'MASTER_LIST'!A:F"   // expanded from A:E to include Zip Code column
  });

  const rows = existing.data.values || [];
  const hasHeader = rows.length > 0 && rows[0][0] === 'Email';
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // Build map of existing records: email -> [email, firstSeen, lastSeen, status, flaggedDate, zip]
  const masterMap = new Map();
  dataRows.forEach(r => {
    if (r[0]) masterMap.set(r[0].toLowerCase().trim(), [...r]);
  });

  // Update/add each synced email
  emailsSynced.forEach(email => {
    const key = email.toLowerCase().trim();
    const zip = zipMap[key] || '';

    if (unsubSet.has(key)) {
      if (masterMap.has(key)) {
        const rec = masterMap.get(key);
        rec[3] = 'unsubscribed';
        if (!rec[4]) rec[4] = today;
        if (zip && !rec[5]) rec[5] = zip;  // only fill zip if not already set
        masterMap.set(key, rec);
      } else {
        masterMap.set(key, [key, today, today, 'unsubscribed', today, zip]);
      }
    } else if (bounceSet.has(key)) {
      if (masterMap.has(key)) {
        const rec = masterMap.get(key);
        rec[3] = 'bounced';
        if (!rec[4]) rec[4] = today;
        if (zip && !rec[5]) rec[5] = zip;
        masterMap.set(key, rec);
      } else {
        masterMap.set(key, [key, today, today, 'bounced', today, zip]);
      }
    } else {
      if (masterMap.has(key)) {
        const rec = masterMap.get(key);
        rec[2] = today;
        // Only upgrade to active — don't overwrite unsubscribed/bounced
        if (rec[3] !== 'unsubscribed' && rec[3] !== 'bounced') rec[3] = 'active';
        if (zip && !rec[5]) rec[5] = zip;  // fill zip if missing
        masterMap.set(key, rec);
      } else {
        masterMap.set(key, [key, today, today, 'active', '', zip]);
      }
    }
  });

  // Also sweep master for any unsub/bounce emails not in this sync
  masterMap.forEach((rec, key) => {
    if (unsubSet.has(key) && rec[3] !== 'unsubscribed') {
      rec[3] = 'unsubscribed';
      if (!rec[4]) rec[4] = today;
      masterMap.set(key, rec);
    } else if (bounceSet.has(key) && rec[3] !== 'unsubscribed' && rec[3] !== 'bounced') {
      rec[3] = 'bounced';
      if (!rec[4]) rec[4] = today;
      masterMap.set(key, rec);
    }
  });

  const outputRows = [
    ['Email', 'First Seen', 'Last Seen', 'Status', 'Flagged Date', 'Zip Code'],
    ...Array.from(masterMap.values()).map(r => [r[0]||'', r[1]||'', r[2]||'', r[3]||'active', r[4]||'', r[5]||''])
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: ACADEMY_SHEET_ID,
    range: "'MASTER_LIST'!A1",
    valueInputOption: 'RAW',
    requestBody: { values: outputRows }
  });

  const activeCount = outputRows.slice(1).filter(r => r[3] === 'active').length;
  const unsubCount = outputRows.slice(1).filter(r => r[3] === 'unsubscribed').length;
  const bounceCount = outputRows.slice(1).filter(r => r[3] === 'bounced').length;
  console.log(`MASTER_LIST updated: ${activeCount} active, ${unsubCount} unsubscribed, ${bounceCount} bounced`);
  return { total: masterMap.size, active: activeCount, unsub: unsubCount, bounced: bounceCount };
}

async function writeToAcademySheet(statsBefore, statsAfter, emailsSynced, unsubSet, bounceSet, sheetsClient, zipMap) {
  if (!ACADEMY_SHEET_ID) return {};
  try {
    const sheets = sheetsClient;

    // Update Sync Log
    await ensureSheet(sheets, ACADEMY_SHEET_ID, 'Sync Log');
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const trueNew = statsAfter.active - statsBefore.active;
    const bounceCount = bounceSet ? bounceSet.size : 0;

    await sheets.spreadsheets.values.update({
      spreadsheetId: ACADEMY_SHEET_ID,
      range: "'Sync Log'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: [['Last Synced', 'Total on List', 'Unsubscribes', 'Active Emails', 'New This Sync', 'Bounces on File']] }
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: ACADEMY_SHEET_ID,
      range: "'Sync Log'!A1",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[now, statsAfter.total, statsAfter.unsub, statsAfter.active, trueNew, bounceCount]] }
    });

    // Update MASTER_LIST (pass zipMap through)
    const masterStats = await updateMasterList(sheets, emailsSynced, unsubSet, bounceSet, zipMap);

    console.log(`Academy sheet updated: ${now}, total=${statsAfter.total}, unsub=${statsAfter.unsub}, active=${statsAfter.active}, new=${trueNew}, bounces=${bounceCount}`);
    return masterStats;
  } catch(e) {
    console.error('Academy sheet write error:', e.message);
    return {};
  }
}

// Queries CC for unsubscribed contacts in a specific list and removes them via bulk activity
async function removeUnsubsFromList(token, listId) {
  const contactIds = [];
  let cursor = null;
  let page = 0;
  try {
    do {
      const url = cursor
        ? `https://api.cc.email/v3/contacts?status=unsubscribed&lists=${listId}&limit=500&cursor=${cursor}`
        : `https://api.cc.email/v3/contacts?status=unsubscribed&lists=${listId}&limit=500`;
      const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json();
      (data.contacts || []).forEach(c => { if (c.contact_id) contactIds.push(c.contact_id); });
      cursor = data._links && data._links.next
        ? new URL('https://api.cc.email' + data._links.next.href).searchParams.get('cursor')
        : null;
      page++;
    } while (cursor && page < 50);
  } catch(e) {
    console.error('removeUnsubsFromList fetch error:', e.message);
    return 0;
  }
  if (contactIds.length === 0) return 0;
  try {
    for (let i = 0; i < contactIds.length; i += 500) {
      const batch = contactIds.slice(i, i + 500);
      await fetch('https://api.cc.email/v3/activities/remove_list_memberships', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: { contact_ids: batch }, list_ids: [listId] })
      });
    }
    console.log(`Removed ${contactIds.length} unsubscribed contacts from list ${listId}`);
  } catch(e) {
    console.error('removeUnsubsFromList remove error:', e.message);
  }
  return contactIds.length;
}

async function writeToProgramsSheet(subcategory, contacts, unsubSet) {
  if (!PROGRAMS_SHEET_ID) return { added: 0, removed: 0, total: 0 };
  const auth = await getGoogleAuth().getClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const today = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  await ensureSheet(sheets, PROGRAMS_SHEET_ID, subcategory);

  // Read existing rows
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: PROGRAMS_SHEET_ID,
    range: `'${subcategory}'!A:D`
  });
  const rows = existing.data.values || [];
  const hasHeader = rows.length > 0 && rows[0][0] === 'Email';
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // Build map: email -> row (preserves existing name/zip data)
  const emailMap = new Map();
  dataRows.forEach(r => {
    const email = (r[0] || '').toLowerCase().trim();
    if (email) emailMap.set(email, [...r]);
  });

  // Merge new contacts (skip existing, skip unsubscribed)
  let added = 0;
  contacts.forEach(c => {
    const key = c.email.toLowerCase().trim();
    if (unsubSet.has(key)) return;
    if (!emailMap.has(key)) {
      emailMap.set(key, [c.email, c.firstName || '', c.lastName || '', c.zip || '']);
      added++;
    }
  });

  // Remove unsubscribed rows
  let removed = 0;
  for (const key of [...emailMap.keys()]) {
    if (unsubSet.has(key)) { emailMap.delete(key); removed++; }
  }

  const outputRows = [
    ['Email', 'First Name', 'Last Name', 'Zip Code'],
    ...Array.from(emailMap.values()).map(r => [r[0]||'', r[1]||'', r[2]||'', r[3]||''])
  ];

  // Clear then rewrite to handle shrinking lists
  await sheets.spreadsheets.values.clear({ spreadsheetId: PROGRAMS_SHEET_ID, range: `'${subcategory}'!A:D` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: PROGRAMS_SHEET_ID,
    range: `'${subcategory}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: outputRows }
  });

  // Update Programs Sync Log (one row per subcategory, upsert by name)
  await ensureSheet(sheets, PROGRAMS_SHEET_ID, 'Programs Sync Log');
  const logExisting = await sheets.spreadsheets.values.get({
    spreadsheetId: PROGRAMS_SHEET_ID,
    range: "'Programs Sync Log'!A:C"
  });
  const logRows = logExisting.data.values || [];
  const logHasHeader = logRows.length > 0 && logRows[0][0] === 'Subcategory';
  const logMap = new Map();
  (logHasHeader ? logRows.slice(1) : logRows).forEach(r => { if (r[0]) logMap.set(r[0], r); });
  logMap.set(subcategory, [subcategory, today, outputRows.length - 1]);
  const logOutput = [
    ['Subcategory', 'Last Synced', 'Total Contacts'],
    ...Array.from(logMap.values())
  ];
  await sheets.spreadsheets.values.clear({ spreadsheetId: PROGRAMS_SHEET_ID, range: "'Programs Sync Log'!A:C" });
  await sheets.spreadsheets.values.update({
    spreadsheetId: PROGRAMS_SHEET_ID,
    range: "'Programs Sync Log'!A1",
    valueInputOption: 'RAW',
    requestBody: { values: logOutput }
  });

  const total = outputRows.length - 1;
  console.log(`Programs sheet "${subcategory}" updated: ${added} added, ${removed} unsubscribers removed, ${total} total`);
  return { added, removed, total };
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
    const { membershipData, unsubEmails = [] } = req.body;
    await writeToMembershipSheet(membershipData, unsubEmails);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch all suppressed emails (unsubscribed from CC + bounced from sheet)
app.get('/unsubscribes', async (req, res) => {
  try {
    const token = await getValidToken();
    const auth = await getGoogleAuth().getClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const [unsubEmails, bounceEmails] = await Promise.all([
      fetchAllUnsubscribes(token),
      readBounceList(sheets)
    ]);
    const allSuppressed = new Set([...unsubEmails, ...bounceEmails]);
    res.json({
      emails: Array.from(allSuppressed),
      count: allSuppressed.size,
      unsubCount: unsubEmails.size,
      bounceCount: bounceEmails.size
    });
  } catch(e) {
    console.error('Unsubscribes fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sync-academy-sheet', async (req, res) => {
  try {
    const { statsBefore, emailsSynced, zipMap } = req.body;  // ── NEW: destructure zipMap
    console.log("sync-academy-sheet received emailsSynced count:", (emailsSynced || []).length);
    const token = await getValidToken();

    // Fetch unsubscribes from CC and bounces from sheet in parallel
    const auth = await getGoogleAuth().getClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const [unsubSet, bounceSet] = await Promise.all([
      fetchAllUnsubscribes(token),
      readBounceList(sheets)
    ]);

    // Wait a few seconds for CC to process the import
    await new Promise(resolve => setTimeout(resolve, 5000));

    const statsAfter = await getAcademyListStats(token);
    const masterStats = await writeToAcademySheet(statsBefore, statsAfter, emailsSynced || [], unsubSet, bounceSet, sheets, zipMap || {});
    res.json({ success: true, statsBefore, statsAfter, trueNew: statsAfter.active - statsBefore.active, masterStats });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// CC unsubscribes only (no bounce list) — used by Programs/Events tab
app.get('/cc-unsubscribes', async (req, res) => {
  try {
    const token = await getValidToken();
    const emails = await fetchAllUnsubscribes(token);
    res.json({ emails: Array.from(emails), count: emails.size });
  } catch(e) {
    console.error('cc-unsubscribes error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/programs-config', (req, res) => {
  res.json({ subcategories: PROGRAMS_SUBCATEGORIES });
});

app.post('/sync-programs-sheet', async (req, res) => {
  try {
    const { subcategory, contacts, listId } = req.body;
    if (!subcategory) return res.status(400).json({ error: 'subcategory required' });

    const token = await getValidToken();
    const unsubSet = await fetchAllUnsubscribes(token);

    // Best-effort: remove unsubscribed contacts from the CC list
    let removedFromCC = 0;
    if (listId) {
      removedFromCC = await removeUnsubsFromList(token, listId);
    }

    const stats = await writeToProgramsSheet(subcategory, contacts || [], unsubSet);
    res.json({ success: true, ...stats, removedFromCC });
  } catch(e) {
    console.error('sync-programs-sheet error:', e.message);
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
