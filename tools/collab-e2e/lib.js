// Two-browser harness: real app at localhost:3000, real backend at localhost:8080 (dev bypass).
// E2E_APP / E2E_API point it at another local stack (e.g. one on other ports).
const puppeteer = require('puppeteer-core');

const API = process.env.E2E_API || 'http://localhost:8080/api';
const APP = process.env.E2E_APP || 'http://localhost:3000';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function para(text, format = 0) {
  return {
    type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', textFormat: 0, textStyle: '',
    children: [{ type: 'text', version: 1, text, format, style: '', mode: 'normal', detail: 0 }],
  };
}

async function api(path, { method = 'GET', body, session = 'dev-admin-session' } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return data;
}

async function createSubmission(paragraphs) {
  const content = JSON.stringify({
    root: { type: 'root', version: 1, format: '', indent: 0, direction: 'ltr', children: paragraphs.map((p) => para(p)) },
  });
  const sub = await api('/content/submissions', {
    method: 'POST',
    body: { title: `E2E ${new Date().toISOString()}`, content, status: 'submitted', requiredApprovers: ['user2@localhost'] },
  });
  return sub;
}

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1400,1000'],
    defaultViewport: { width: 1400, height: 1000 },
  });
}

/**
 * One user in an isolated browser context. Records console errors and every JSON message
 * sent on the room socket (to prove no whole-document traffic in collaborative mode).
 */
async function openUser(browser, name, session, submissionId) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const user = { name, page, context, errors: [], roomSent: [], yjsFrames: 0, logs: [] };
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error') user.errors.push(t);
    if (/\[YJS\]|Collaboration connected|TransactionManager|\[TrackedChangesEditor\] transaction-saved|\[DBG\]/.test(t)) user.logs.push(t.slice(0, 300));
  });
  page.on('pageerror', (err) => user.errors.push(`pageerror: ${err.message}`));
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const sockets = new Map();
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => sockets.set(requestId, url));
  cdp.on('Network.webSocketFrameSent', ({ requestId, response }) => {
    const url = sockets.get(requestId) || '';
    if (url.includes('/ws/yjs/')) { user.yjsFrames++; return; }
    if (url.includes('/ws/submissions/')) {
      try { user.roomSent.push(JSON.parse(response.payloadData).type); } catch { /* binary */ }
    }
  });
  user.sockets = sockets;
  user.changePosts = [];
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.method === 'POST' && /\/tracked-changes\/submission\/[^/]+$/.test(request.url)) user.changePosts.push(request.postData || '');
  });
  // Keep every WebSocket the page opens, so tests can drop connections (a real outage).
  await page.evaluateOnNewDocument(() => {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = function (url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      window.__sockets.push(ws);
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  user.dropConnections = async () => {
    await page.setOfflineMode(true);
    await page.evaluate(() => window.__sockets.forEach((ws) => { if (ws.url.includes('/api/ws/')) ws.close(); }));
  };
  user.restoreConnections = () => page.setOfflineMode(false);

  await page.goto(`${APP}/requests`, { waitUntil: 'domcontentloaded' });
  const me = await api('/auth/me', { session });
  await page.evaluate((s, u) => {
    localStorage.setItem('sessionId', s);
    localStorage.setItem('user', JSON.stringify(u));
  }, session, me.user);
  await page.goto(`${APP}/tracked-changes/${submissionId}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('.proposed-collaborative-editor .collaborative-editor-input[contenteditable="true"]', { timeout: 20000 });
  } catch (e) {
    await page.screenshot({ path: `fail-${name}.png` });
    const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
    const ce = await page.evaluate(() => { const el = document.querySelector('.collaborative-editor-input'); return el ? el.outerHTML.slice(0, 300) : 'no editor'; });
    console.error(`[${name}] editor not editable. url=${page.url()}\nbody=${body}\neditor=${ce}\nerrors=${user.errors.slice(0, 8).join('\n')}\nlogs=${user.logs.join('\n')}\nsockets=${[...sockets.values()].join(', ')}`);
    throw e;
  }
  return user;
}

const EDITOR = '.proposed-collaborative-editor .collaborative-editor-input';

/** Editor text per top-level block (deleted-text markers excluded). */
async function blocks(user) {
  return user.page.$$eval(`${EDITOR} > *`, (els) => els.map((el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.tracked-deletion-wrapper').forEach((d) => d.remove());
    return clone.textContent;
  }));
}

async function html(user) {
  return user.page.$eval(EDITOR, (el) => el.innerHTML);
}

/** Place the caret in block `index` at character `offset` (or at the end with offset = -1). */
async function caret(user, index, offset = -1) {
  await user.page.evaluate((sel, index, offset) => {
    const block = document.querySelector(sel).children[index];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('.tracked-deletion-wrapper') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    const range = document.createRange();
    if (offset < 0) {
      const last = nodes[nodes.length - 1];
      range.setStart(last, last.textContent.length);
    } else {
      let remaining = offset;
      for (const t of nodes) {
        if (remaining <= t.textContent.length) { range.setStart(t, remaining); break; }
        remaining -= t.textContent.length;
      }
    }
    range.collapse(true);
    document.querySelector(sel).focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, EDITOR, index, offset);
  await sleep(80);
}

/** Select characters [start, end) of block `index`. */
async function select(user, index, start, end) {
  await user.page.evaluate((sel, index, start, end) => {
    const block = document.querySelector(sel).children[index];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    const locate = (pos) => {
      let remaining = pos;
      for (const t of nodes) {
        if (remaining <= t.textContent.length) return [t, remaining];
        remaining -= t.textContent.length;
      }
      const last = nodes[nodes.length - 1];
      return [last, last.textContent.length];
    };
    const range = document.createRange();
    range.setStart(...locate(start));
    range.setEnd(...locate(end));
    document.querySelector(sel).focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, EDITOR, index, start, end);
  await sleep(80);
}

async function waitFor(cond, what, timeoutMs = 10000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await cond();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`Timed out: ${what}`);
}

async function converged(a, b) {
  return waitFor(async () => {
    const [x, y] = [await blocks(a), await blocks(b)];
    return JSON.stringify(x) === JSON.stringify(y) ? x : null;
  }, `${a.name}/${b.name} converge`);
}

const count = (hay, needle) => hay.split(needle).length - 1;

module.exports = { api, createSubmission, launch, openUser, blocks, html, caret, select, waitFor, converged, count, sleep, EDITOR, API };
