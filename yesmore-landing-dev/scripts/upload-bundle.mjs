#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_HTML_BYTES = 4 * 1024 * 1024;
const PRODUCTION_UPLOAD_TEMPLATE = 'https://yesmore.co/api/p/landing-bundles/{landingPageId}';
const STAGING_UPLOAD_TEMPLATE = 'https://yesmoreco.com/api/p/landing-bundles/{landingPageId}';
const TOKEN_PATTERN = /^ymb_[A-Za-z0-9_-]+$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LANDING_ID_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RESERVED_IDS = new Set(['default', 'next', 'staging', 'www']);

function fail(message) {
  process.stderr.write(`Upload failed: ${message}\n`);
  process.exit(1);
}

function cloudflareAccessToken(origin) {
  const result = spawnSync('cloudflared', ['access', 'token', `-app=${origin}`], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });
  if (result.error?.code === 'ENOENT') {
    fail('staging is protected by Cloudflare Access and cloudflared is not installed.');
  }
  if (result.error || result.status !== 0) {
    fail('Cloudflare Access authentication did not complete successfully.');
  }
  const accessToken = (result.stdout || '').trim();
  if (!ACCESS_TOKEN_PATTERN.test(accessToken)) {
    fail('Cloudflare Access authentication returned an invalid token.');
  }
  return accessToken;
}

function decodeAttributeEntities(value) {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(colon|tab|newline));?/gi, (entity, hex, decimal, named) => {
    if (named) return { colon: ':', tab: '\t', newline: '\n' }[named.toLowerCase()];
    const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function parsedAttributes(attributes) {
  const parsed = [];
  let cursor = 0;
  while (cursor < attributes.length) {
    while (cursor < attributes.length && /[\s/]/.test(attributes[cursor])) cursor += 1;
    const nameStart = cursor;
    while (cursor < attributes.length && !/[\s=/'"<>]/.test(attributes[cursor])) cursor += 1;
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = attributes.slice(nameStart, cursor).toLowerCase();
    while (cursor < attributes.length && /\s/.test(attributes[cursor])) cursor += 1;
    let value = '';
    if (attributes[cursor] === '=') {
      cursor += 1;
      while (cursor < attributes.length && /\s/.test(attributes[cursor])) cursor += 1;
      const quote = attributes[cursor] === '"' || attributes[cursor] === "'"
        ? attributes[cursor++]
        : '';
      const valueStart = cursor;
      if (quote) {
        while (cursor < attributes.length && attributes[cursor] !== quote) cursor += 1;
        value = attributes.slice(valueStart, cursor);
        if (attributes[cursor] === quote) cursor += 1;
      } else {
        while (cursor < attributes.length && !/\s/.test(attributes[cursor])) cursor += 1;
        value = attributes.slice(valueStart, cursor);
      }
    }
    parsed.push({ name, value: decodeAttributeEntities(value) });
  }
  return parsed;
}

function attributeValue(attributes, expectedName) {
  for (const attribute of parsedAttributes(attributes)) {
    if (attribute.name === expectedName) return attribute.value;
  }
  return undefined;
}

function findTagEnd(html, start, label) {
  let quote = '';
  let expectingValue = false;
  let unquotedValue = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '>') {
      return index;
    } else if (expectingValue) {
      if (/\s/.test(character)) continue;
      expectingValue = false;
      if (character === '"' || character === "'") quote = character;
      else unquotedValue = true;
    } else if (unquotedValue) {
      if (/\s/.test(character)) unquotedValue = false;
    } else if (character === '=') {
      expectingValue = true;
    }
  }
  throw new Error(`${label} contains an unterminated tag.`);
}

function scanHtml(html, label = 'index.html') {
  const startTags = [];
  const endTags = [];
  const scripts = [];
  let doctypeSeen = false;
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) throw new Error(`${label} contains an unterminated comment.`);
      const comment = html.slice(start, end + 3);
      if (!/^<!--(?:[^<>-]|-(?!-))*-->$/.test(comment)) {
        throw new Error(`${label} contains an unsafe or malformed comment.`);
      }
      cursor = end + 3;
      continue;
    }

    const remainder = html.slice(start);
    const closing = /^<\/([a-z][a-z0-9:-]*)\s*>/i.exec(remainder);
    if (closing) {
      endTags.push({ name: closing[1].toLowerCase(), index: start, end: start + closing[0].length });
      cursor = start + closing[0].length;
      continue;
    }
    const doctype = /^<!doctype\s+html\s*>/i.exec(remainder);
    if (doctype) {
      if (doctypeSeen) throw new Error(`${label} cannot contain more than one doctype.`);
      doctypeSeen = true;
      cursor = start + doctype[0].length;
      continue;
    }
    if (/^<!|^<\?/.test(remainder)) {
      throw new Error(`${label} contains an unsupported markup declaration.`);
    }

    const opening = /^<([a-z][a-z0-9:-]*)\b/i.exec(remainder);
    if (!opening) {
      cursor = start + 1;
      continue;
    }
    const end = findTagEnd(html, start + opening[0].length, label);
    const name = opening[1].toLowerCase();
    const attributes = html.slice(start + opening[0].length, end);
    startTags.push({ name, attributes, index: start, end: end + 1 });
    cursor = end + 1;

    if (name === 'script' || name === 'style' || name === 'title' || name === 'textarea') {
      const closingPattern = new RegExp('<\\/' + name + '\\s*>', 'ig');
      closingPattern.lastIndex = cursor;
      const rawClosing = closingPattern.exec(html);
      if (!rawClosing) throw new Error(`${label} contains an unterminated <${name}> element.`);
      if (name === 'script') scripts.push(html.slice(cursor, rawClosing.index));
      endTags.push({ name, index: rawClosing.index, end: closingPattern.lastIndex });
      cursor = closingPattern.lastIndex;
    }
  }

  return { startTags, endTags, scripts };
}

function onlyTag(tags, name, documentLabel, tagLabel) {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length !== 1) {
    throw new Error(`${documentLabel} must contain exactly one ${tagLabel}.`);
  }
  return matches[0];
}

function containsBundleOwnedAuthField(startTags) {
  for (const tag of startTags.filter((entry) => entry.name === 'input')) {
    const attributes = tag.attributes;
    const type = (attributeValue(attributes, 'type') || 'text').toLowerCase();
    const name = (attributeValue(attributes, 'name') || '').toLowerCase();
    const autocomplete = (attributeValue(attributes, 'autocomplete') || '').toLowerCase();
    if (
      type === 'tel'
      || autocomplete.split(/\s+/).some((value) => value === 'tel' || value === 'one-time-code')
      || /^(?:phone|phone-number|phonenumber|code|otp|verification-code|verification_code)$/.test(name)
    ) {
      return true;
    }
  }
  return false;
}

function decodeCompleteDocument(buffer, label = 'index.html', maxBytes = MAX_HTML_BYTES) {
  if (buffer.length === 0) {
    throw new Error(`${label} must be non-empty.`);
  }
  if (buffer.length > maxBytes) {
    throw new Error(label === 'index.html'
      ? 'index.html must be no larger than 2 MiB.'
      : `${label} exceeded the safe verification size limit.`);
  }

  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }

  const doctype = /^\uFEFF?\s*<!doctype\s+html\s*>/i.exec(html);
  if (!doctype) {
    throw new Error(`${label} must begin with an HTML doctype.`);
  }
  const parsed = scanHtml(html, label);
  const openingHtml = onlyTag(parsed.startTags, 'html', label, 'opening <html> tag');
  const openingHead = onlyTag(parsed.startTags, 'head', label, 'opening <head> tag');
  const closingHead = onlyTag(parsed.endTags, 'head', label, 'closing </head> tag');
  const openingBody = onlyTag(parsed.startTags, 'body', label, 'opening <body> tag');
  const closingBody = onlyTag(parsed.endTags, 'body', label, 'closing </body> tag');
  const closingHtml = onlyTag(parsed.endTags, 'html', label, 'closing </html> tag');
  const positions = [
    openingHtml.index,
    openingHead.index,
    closingHead.index,
    openingBody.index,
    closingBody.index,
    closingHtml.index,
  ];
  if (positions[0] < doctype.index + doctype[0].length
    || !positions.every((value, index) => index === 0 || value > positions[index - 1])
    || html.slice(closingHtml.end).trim() !== '') {
    throw new Error(`${label} must contain one complete, correctly ordered HTML document.`);
  }
  return { html, parsed };
}

function countSignUpTriggers(startTags) {
  let count = 0;
  for (const tag of startTags) {
    const { name: tagName, attributes } = tag;
    const action = attributeValue(attributes, 'data-yesmore-action');
    if (action?.toLowerCase() === 'sign-up' && action !== 'sign-up') {
      throw new Error('The sign-up action value must use exact lowercase "sign-up".');
    }
    if (action !== 'sign-up') continue;
    if (
      tagName !== 'button'
      || attributeValue(attributes, 'type') !== 'button'
    ) {
      throw new Error(
        'Sign-up triggers must be buttons with type="button" and data-yesmore-action="sign-up".',
      );
    }
    count += 1;
  }
  return count;
}

function containsTrustedRuntime(scriptCode) {
  return scriptCode.includes('button[type="button"][data-yesmore-action="sign-up"]')
    && scriptCode.includes('data-yesmore-auth-root')
    && scriptCode.includes('/api/p/auth/landing-surface');
}

function validateHostedContract(buffer) {
  const { html, parsed } = decodeCompleteDocument(buffer);
  if (parsed.startTags.some((tag) => ['iframe', 'frame', 'object', 'base'].includes(tag.name))) {
    throw new Error('Frames, objects, and base elements are not allowed.');
  }
  if (parsed.startTags.some(
    (tag) => tag.name === 'meta'
      && (attributeValue(tag.attributes, 'http-equiv') || '').toLowerCase() === 'refresh',
  )) {
    throw new Error('Meta refresh redirects are not allowed.');
  }
  if (parsed.startTags.some((tag) => {
    const attributes = parsedAttributes(tag.attributes);
    return (tag.name === 'form' && attributes.some((entry) => entry.name === 'action' || entry.name === 'target'))
      || attributes.some((entry) => entry.name === 'formaction' || entry.name === 'formtarget');
  })) {
    throw new Error('Custom form actions and targets are not allowed.');
  }
  if (parsed.startTags.some(
    (tag) => tag.name === 'script' && attributeValue(tag.attributes, 'src') !== undefined,
  )) {
    throw new Error('External scripts are not allowed.');
  }
  if (parsed.startTags.some(
    (tag) => parsedAttributes(tag.attributes).some((entry) => /^on[a-z][a-z0-9_-]*$/.test(entry.name)),
  )) {
    throw new Error('Inline event-handler attributes are not allowed.');
  }
  if (parsed.startTags.some((tag) => parsedAttributes(tag.attributes).some((entry) => {
    if (entry.name !== 'href' && entry.name !== 'src') return false;
    const normalized = entry.value.replace(/[\t\n\r]/g, '').trimStart();
    return /^javascript\s*:/i.test(normalized);
  }))) {
    throw new Error('javascript: URLs are not allowed.');
  }
  if (containsBundleOwnedAuthField(parsed.startTags)) {
    throw new Error('Hosted bundles cannot implement phone or OTP fields.');
  }

  const scriptCode = parsed.scripts.join('\n');
  if (containsTrustedRuntime(scriptCode)) {
    throw new Error('Hosted bundles cannot include trusted runtime marker signatures.');
  }
  const forbiddenScript = [
    ['cookies', /\bdocument\s*\.\s*cookie\b/i],
    ['local or session storage', /\b(?:localStorage|sessionStorage)\b/i],
    ['direct network APIs', /\b(?:fetch\s*\(|XMLHttpRequest|EventSource|WebSocket|sendBeacon\s*\()/i],
    ['workers', /\b(?:SharedWorker|Worker\s*\(|serviceWorker)\b/i],
    ['dynamic frames or objects', /\bcreateElement\s*\(\s*["'](?:iframe|frame|object|base)["']/i],
    ['custom windows', /\b(?:window\s*\.\s*)?open\s*\(/i],
    ['location access', /(?:\blocation\b|["']location["'])/i],
    ['bundle-owned authentication', /\b(?:YesMoreAuth|sendOtp\s*\(|validateOtp\s*\()/i],
  ];
  for (const [label, pattern] of forbiddenScript) {
    if (pattern.test(scriptCode)) throw new Error(`Hosted bundles cannot use ${label}.`);
  }
  return { html, signUpTriggerCount: countSignUpTriggers(parsed.startTags) };
}

function validatePreviewUrl(value, landingPageId, uploadUrl) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('HTTP 201 response did not include a valid previewUrl.');
  }

  let previewUrl;
  try {
    previewUrl = new URL(value);
  } catch {
    throw new Error('HTTP 201 response did not include a valid previewUrl.');
  }
  if (previewUrl.username || previewUrl.password) {
    throw new Error('previewUrl must not contain a username or password.');
  }

  if (previewUrl.origin === uploadUrl.origin) {
    return previewUrl;
  }

  if (previewUrl.protocol !== 'https:' || previewUrl.port !== '') {
    throw new Error('cross-origin previewUrl must use HTTPS on the default port.');
  }
  const allowedHosts = new Set([
    `${landingPageId}.yesmore.co`,
    `${landingPageId}.yesmoreco.com`,
  ]);
  const uploadHostOwned = uploadUrl.hostname === 'yesmore.co'
    || uploadUrl.hostname.endsWith('.yesmore.co')
    || uploadUrl.hostname === 'yesmoreco.com'
    || uploadUrl.hostname.endsWith('.yesmoreco.com');
  if (!uploadHostOwned) {
    throw new Error('configured upload hostname cannot authorize a cross-origin preview.');
  }
  if (!allowedHosts.has(previewUrl.hostname)) {
    throw new Error('previewUrl hostname is not the requested YesMore landing-page host.');
  }
  return previewUrl;
}

function safeStatus(response) {
  return `HTTP ${response.status}`;
}

function unauthorizedGuidance(source) {
  return source === 'environment'
    ? 'Update or remove YESMORE_LANDING_BUNDLE_TOKEN in the host encrypted-secret facility.'
    : 'Run $yesmore-landing-dev configure to replace the protected file credential.';
}

function credentialFilePath() {
  if (process.env.XDG_CONFIG_HOME) {
    return `${process.env.XDG_CONFIG_HOME}/yesmore/landing-dev/credential`;
  }
  if (process.env.HOME) {
    return `${process.env.HOME}/.config/yesmore/landing-dev/credential`;
  }
  fail('no user configuration directory is available.');
}

function authenticatedAdminPreviewUrl(uploadUrl, landingPageId, bundleId) {
  return new URL(
    `/admin/landing-bundles/${encodeURIComponent(landingPageId)}/preview/${bundleId}`,
    uploadUrl.origin,
  );
}

function openBrowser(url) {
  if (process.env.YESMORE_UPLOAD_NO_OPEN === '1') return;
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: 'ignore',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(`Upload succeeded; open the authenticated preview manually: ${url}\n`);
  }
}

const uploadArgs = process.argv.slice(2);
const useStaging = uploadArgs[0] === '--staging';
if (useStaging) uploadArgs.shift();
if (uploadArgs.length !== 3) {
  fail('usage: upload-bundle.mjs [--staging] <landing-page-id> <title> <path-to-index.html>');
}

const [landingPageId, title, htmlPath] = uploadArgs;
if (!LANDING_ID_PATTERN.test(landingPageId) || RESERVED_IDS.has(landingPageId)) {
  fail('landing page ID must be 1–63 lowercase letters, numbers, or hyphens, start and end alphanumerically, and not be reserved.');
}
if (!title || /[^\u0020-\u007e]/.test(title)) {
  fail('title must be non-empty printable ASCII so it can be sent safely as an HTTP header.');
}

let html;
let signUpTriggerCount;
try {
  ({ html, signUpTriggerCount } = validateHostedContract(await readFile(htmlPath)));
} catch (error) {
  fail(error instanceof Error ? error.message : 'could not validate index.html.');
}

const uploadTemplate = useStaging ? STAGING_UPLOAD_TEMPLATE : PRODUCTION_UPLOAD_TEMPLATE;
const uploadUrl = new URL(uploadTemplate.replace('{landingPageId}', encodeURIComponent(landingPageId)));

const ensureScript = fileURLToPath(new URL('./ensure-credential.sh', import.meta.url));
const ensured = spawnSync(ensureScript, [], { env: process.env, stdio: 'inherit' });
if (ensured.error || ensured.status !== 0) {
  fail('credential check did not complete successfully.');
}

let token;
let credentialSource;
if (Object.hasOwn(process.env, 'YESMORE_LANDING_BUNDLE_TOKEN')) {
  token = process.env.YESMORE_LANDING_BUNDLE_TOKEN;
  credentialSource = 'environment';
  delete process.env.YESMORE_LANDING_BUNDLE_TOKEN;
} else {
  const credentialPath = credentialFilePath();
  try {
    const metadata = await lstat(credentialPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      fail('stored credential must be a regular, non-symlink file with mode 600. Run configure to replace it.');
    }
    token = await readFile(credentialPath, 'utf8');
    credentialSource = 'file';
  } catch {
    fail('could not read the protected credential file.');
  }
}

if (!TOKEN_PATTERN.test(token)) {
  fail('credential validation failed. Use the host encrypted-secret facility or run configure; never provide the value in chat.');
}

const authorization = `Bearer ${token}`;
const uploadAccessToken = useStaging ? cloudflareAccessToken(uploadUrl.origin) : null;
const uploadHeaders = {
  Authorization: authorization,
  'Content-Type': 'text/html',
  'X-Landing-Bundle-Title': title,
};
if (uploadAccessToken) uploadHeaders['cf-access-token'] = uploadAccessToken;

let uploadResponse;
try {
  uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: uploadHeaders,
    body: html,
    redirect: 'manual',
  });
} catch {
  fail('the upload request could not be completed.');
}

if (!uploadResponse.ok) {
  const status = safeStatus(uploadResponse);
  fail(`${status}.${uploadResponse.status === 401 ? ` ${unauthorizedGuidance(credentialSource)}` : ''}`);
}
if (uploadResponse.status !== 201) {
  fail(`expected HTTP 201 but received ${safeStatus(uploadResponse)}.`);
}

let payload;
try {
  payload = await uploadResponse.json();
} catch {
  fail('HTTP 201 response was not valid JSON.');
}

const bundle = payload?.bundle;
const rawPreviewUrl = payload?.previewUrl;
if (!Number.isInteger(bundle?.id) || bundle.id < 1) {
  fail('HTTP 201 response did not include a valid integer bundle.id.');
}
if (bundle.landingKey !== landingPageId) {
  fail('HTTP 201 response landing key did not match the requested ID.');
}
if (!/^[a-f0-9]{64}$/.test(bundle.checksum)) {
  fail('HTTP 201 response did not include a valid bundle.checksum.');
}
if (bundle.isActive !== false) {
  fail('HTTP 201 response must describe an inactive immutable bundle.');
}

let previewUrl;
try {
  previewUrl = validatePreviewUrl(rawPreviewUrl, landingPageId, uploadUrl);
} catch (error) {
  fail(error instanceof Error ? error.message : 'HTTP 201 response included an unsafe previewUrl.');
}

let previewResponse;
try {
  const previewHeaders = { Authorization: authorization };
  if (uploadAccessToken && previewUrl.origin === uploadUrl.origin) {
    previewHeaders['cf-access-token'] = uploadAccessToken;
  }
  previewResponse = await fetch(previewUrl, {
    headers: previewHeaders,
    redirect: 'manual',
  });
} catch {
  fail('authenticated remote preview verification could not be completed.');
}

if (!previewResponse.ok) {
  const status = safeStatus(previewResponse);
  fail(`remote preview returned ${status}.${previewResponse.status === 401 ? ` ${unauthorizedGuidance(credentialSource)}` : ''}`);
}
if (previewResponse.status !== 200) {
  fail(`remote preview expected HTTP 200 but received ${safeStatus(previewResponse)}.`);
}
const contentType = (previewResponse.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
if (contentType !== 'text/html') {
  fail('remote preview Content-Type was not text/html.');
}

const contentLength = previewResponse.headers.get('content-length');
if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REMOTE_HTML_BYTES) {
  fail('remote preview body exceeded the safe verification size limit.');
}

let remoteHtml;
let remoteParsed;
try {
  ({ html: remoteHtml, parsed: remoteParsed } = decodeCompleteDocument(
    new Uint8Array(await previewResponse.arrayBuffer()),
    'remote preview',
    MAX_REMOTE_HTML_BYTES,
  ));
} catch (error) {
  fail(error instanceof Error ? error.message : 'remote preview was not valid HTML.');
}

const remoteScripts = remoteParsed.scripts;
if (!remoteScripts.some(containsTrustedRuntime)) {
  fail('remote preview did not contain the injected trusted YesMore sign-up runtime.');
}
if (signUpTriggerCount > 0) {
  let remoteSignUpTriggerCount;
  try {
    remoteSignUpTriggerCount = countSignUpTriggers(remoteParsed.startTags);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'remote preview sign-up trigger was invalid.');
  }
  if (remoteSignUpTriggerCount < 1) {
    fail('remote preview did not preserve the uploaded declarative sign-up trigger.');
  }
}

const authenticatedPreviewUrl = authenticatedAdminPreviewUrl(
  uploadUrl,
  landingPageId,
  bundle.id,
);
process.stdout.write([
  'YesMore landing bundle uploaded and remotely verified.',
  `Landing page ID: ${landingPageId}`,
  `Version ID: ${bundle.id}`,
  `Checksum: ${bundle.checksum}`,
  `Authenticated preview URL: ${authenticatedPreviewUrl.href}`,
  'API-key remote preview verification: passed',
].join('\n') + '\n');
openBrowser(authenticatedPreviewUrl.href);
