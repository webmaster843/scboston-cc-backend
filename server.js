const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CC_API_KEY = process.env.CC_API_KEY;
const CC_CLIENT_SECRET = process.env.CC_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let storedTokens = {
  access_token: '',
  refresh_token: '',
  expires_at: 0
};

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
  } else {
    throw new Error('Token refresh failed: ' + JSON.stringify(data));
  }
}

async function getValidToken() {
