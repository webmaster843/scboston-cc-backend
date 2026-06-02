const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const CC_API_KEY = process.env.CC_API_KEY;
const CC_CLIENT_SECRET = process.env.CC_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let storedTokens = {
  access_token: process.env.INITIAL_ACCESS_TOKEN || '',
  refresh_token: process.env.INITIAL_REFRESH_TOKEN || '',
  expires_at: 0
};

async function refreshAccessToken() {
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
    console.log('Token refreshed successfully');
  } else {
    console.error('Token refresh failed:', data);
  }
}

async function getValidToken() {
  if (Date.now() > storedTokens.expires_at) {
    await refreshAccessToken();
  }
  return storedTokens.access_token;
}

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
    const resp = await fetch('https://api.cc.email/v3/activities/contact_imports', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contacts: contacts,
        list_id: list_id
      })
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');
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
    res.send('<h2>Authorization successful!</h2><p>You can close this tab. The backend is now connected to Constant Contact.</p>');
  } else {
    res.status(500).send('<h2>Authorization failed</h2><pre>' + JSON.stringify(data, null, 2) + '</pre>');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
