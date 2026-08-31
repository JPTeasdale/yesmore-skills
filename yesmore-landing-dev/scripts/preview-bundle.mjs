#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import process from 'node:process';
import { TextDecoder } from 'node:util';

const MAX_HTML_BYTES = 2 * 1024 * 1024;

function fail(message) {
  process.stderr.write('Preview failed: ' + message + '\n');
  process.exit(1);
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
  throw new Error(label + ' contains an unterminated tag.');
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
      if (end < 0) throw new Error(label + ' contains an unterminated comment.');
      const comment = html.slice(start, end + 3);
      if (!/^<!--(?:[^<>-]|-(?!-))*-->$/.test(comment)) {
        throw new Error(label + ' contains an unsafe or malformed comment.');
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
      if (doctypeSeen) throw new Error(label + ' cannot contain more than one doctype.');
      doctypeSeen = true;
      cursor = start + doctype[0].length;
      continue;
    }
    if (/^<!|^<\?/.test(remainder)) {
      throw new Error(label + ' contains an unsupported markup declaration.');
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
      if (!rawClosing) throw new Error(label + ' contains an unterminated <' + name + '> element.');
      if (name === 'script') scripts.push(html.slice(cursor, rawClosing.index));
      endTags.push({ name, index: rawClosing.index, end: closingPattern.lastIndex });
      cursor = closingPattern.lastIndex;
    }
  }

  return { startTags, endTags, scripts };
}

function onlyTag(tags, name, label) {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length !== 1) {
    throw new Error('index.html must contain exactly one ' + label + '.');
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

function validateSignUpTriggers(startTags) {
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
  }
}

function validateDocument(buffer) {
  if (buffer.length === 0 || buffer.length > MAX_HTML_BYTES) {
    throw new Error('index.html must be non-empty and no larger than 2 MiB.');
  }

  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('index.html must be valid UTF-8.');
  }

  const doctype = /^\uFEFF?\s*<!doctype\s+html\s*>/i.exec(html);
  if (!doctype) throw new Error('index.html must begin with an HTML doctype.');

  const parsed = scanHtml(html);
  const openingHtml = onlyTag(parsed.startTags, 'html', 'opening <html> tag');
  const openingHead = onlyTag(parsed.startTags, 'head', 'opening <head> tag');
  const closingHead = onlyTag(parsed.endTags, 'head', 'closing </head> tag');
  const openingBody = onlyTag(parsed.startTags, 'body', 'opening <body> tag');
  const closingBody = onlyTag(parsed.endTags, 'body', 'closing </body> tag');
  const closingHtml = onlyTag(parsed.endTags, 'html', 'closing </html> tag');
  const positions = [
    openingHtml.index,
    openingHead.index,
    closingHead.index,
    openingBody.index,
    closingBody.index,
    closingHtml.index,
  ];
  if (
    positions[0] < doctype.index + doctype[0].length
    || !positions.every((value, index) => index === 0 || value > positions[index - 1])
  ) {
    throw new Error('HTML document elements are not in a complete, valid order.');
  }
  if (html.slice(closingHtml.end).trim() !== '') {
    throw new Error('Nothing may follow the closing </html> tag.');
  }

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
  if (
    scriptCode.includes('button[type="button"][data-yesmore-action="sign-up"]')
    && scriptCode.includes('data-yesmore-auth-root')
    && scriptCode.includes('/api/p/auth/landing-surface')
  ) {
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
    if (pattern.test(scriptCode)) throw new Error('Hosted bundles cannot use ' + label + '.');
  }

  validateSignUpTriggers(parsed.startTags);
  return { html, headEnd: openingHead.end };
}

const previewRuntimeSuffix = randomBytes(12).toString('hex');
const previewHostId = 'yesmore-preview-host-' + previewRuntimeSuffix;
const previewStyles = String.raw`
.ym-root{--ym-surface:var(--yesmore-auth-surface,#fff);--ym-text:var(--yesmore-auth-text,#181817);--ym-muted:var(--yesmore-auth-muted,#65645f);--ym-border:var(--yesmore-auth-border,#deddd8);--ym-accent:var(--yesmore-auth-accent,#252522);--ym-accent-text:var(--yesmore-auth-accent-text,#fff);position:fixed;inset:0;z-index:2147483646;color:var(--ym-text);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.ym-root[hidden]{display:none}
.ym-root *{box-sizing:border-box}
.ym-backdrop{position:fixed;inset:0;display:grid;place-items:center;padding:24px;background:rgba(20,20,18,.56);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.ym-panel{position:relative;width:min(440px,100%);max-height:calc(100dvh - 48px);overflow:auto;border:1px solid var(--ym-border);border-radius:24px;background:var(--ym-surface);color:var(--ym-text);padding:30px;box-shadow:0 24px 80px rgba(20,20,18,.24);animation:ym-enter .22s cubic-bezier(.16,1,.3,1)}
.ym-close{position:absolute;top:18px;right:18px;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--ym-border);border-radius:999px;background:transparent;color:var(--ym-text);cursor:pointer;font-family:inherit;font-size:20px;font-weight:700;line-height:1}
.ym-close:hover{background:color-mix(in srgb,var(--ym-text) 6%,transparent)}
.ym-kicker{margin:0 44px 8px 0;color:var(--ym-muted);font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.ym-title{margin:0 44px 8px 0;color:var(--ym-text);font-size:28px;line-height:1.08;letter-spacing:-.035em}
.ym-description{margin:0;color:var(--ym-muted);font-size:14px;line-height:1.55}
.ym-form{display:grid;gap:18px;margin-top:26px}
.ym-field{display:grid;gap:8px;color:var(--ym-text);font-size:13px;font-weight:650}
.ym-input{width:100%;height:48px;border:1px solid var(--ym-border);border-radius:12px;background:var(--ym-surface);color:var(--ym-text);padding:0 14px;font:inherit;font-size:16px;outline:none}
.ym-input:focus{border-color:var(--ym-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ym-accent) 18%,transparent)}
.ym-button{display:inline-flex;min-height:48px;align-items:center;justify-content:center;border-radius:12px;padding:0 18px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:transform .15s ease,opacity .15s ease}
.ym-button:disabled{cursor:wait;opacity:.58}
.ym-primary{width:100%;border:1px solid var(--ym-accent);background:var(--ym-accent);color:var(--ym-accent-text)}
.ym-secondary{min-height:38px;border:0;background:transparent;color:var(--ym-text);padding:0 8px;text-decoration:underline;text-underline-offset:4px}
.ym-button:focus-visible,.ym-close:focus-visible{outline:3px solid color-mix(in srgb,var(--ym-accent) 35%,transparent);outline-offset:2px}
.ym-subactions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:-4px}
.ym-error{margin:0;border-left:3px solid #b42318;background:#fef3f2;color:#8a1c13;padding:10px 12px;font-size:13px;line-height:1.45}
.ym-status{margin:0;color:var(--ym-muted);font-size:13px;line-height:1.45}
.ym-privacy{margin:0;color:var(--ym-muted);font-size:11px;line-height:1.5}
.ym-activity{position:fixed;top:12px;right:12px;z-index:2147483647;width:min(340px,calc(100vw - 24px));border:1px solid #171816;border-radius:10px;background:#fff;color:#171816;box-shadow:0 8px 30px rgba(0,0,0,.2);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.ym-activity summary{cursor:pointer;padding:10px 12px;font-weight:700}
.ym-activity div{padding:0 12px 12px}
.ym-log{max-height:120px;overflow:auto;white-space:pre-wrap;margin:8px 0 0;font:inherit}
@keyframes ym-enter{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@media(max-width:640px){.ym-backdrop{place-items:end center;padding:0}.ym-panel{width:100%;max-height:calc(100dvh - 12px);border-width:1px 0 0;border-radius:22px 22px 0 0;padding:26px 20px calc(20px + env(safe-area-inset-bottom));animation-name:ym-drawer-enter}.ym-title{font-size:25px}@keyframes ym-drawer-enter{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}}
@media(prefers-reduced-motion:reduce){.ym-panel{animation:none}.ym-button{transition:none}}
`;

const injectedRuntime = String.raw`<script>
(() => {
  const signUpSelector = 'button[type="button"][data-yesmore-action="sign-up"]';
  const queued = [];
  let host;
  let shadow;
  let root;
  let activity;
  let lastTrigger;
  let previousOverflow = '';
  let inertEntries = [];
  let surfaceGeneration = 0;
  let activitySummary;
  let activityOutput;
  let state = initialState();

  function initialState() {
    return { step: 'phone', phone: '', phoneDisplay: '', code: '', busy: false, error: '', status: '' };
  }

  function record(name, detail) {
    queued.push({ name, detail, time: new Date().toLocaleTimeString() });
    if (activitySummary) activitySummary.textContent = 'YesMore mock · ' + name;
    if (activityOutput) {
      activityOutput.textContent = queued.map((entry) => entry.time + ' — ' + entry.name + ': ' + entry.detail).join('\n');
    }
  }

  function formatPhone(raw) {
    const trimmed = String(raw || '').trim();
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return trimmed.startsWith('+') ? '+' : '';
    if (trimmed.startsWith('+') && !(digits.length === 11 && digits.startsWith('1'))) {
      return '+' + digits.slice(0, 15);
    }
    const usDigits = digits.length <= 10 ? digits : digits.startsWith('1') && digits.length <= 11 ? digits.slice(1) : null;
    if (usDigits === null) return digits.slice(0, 15);
    if (usDigits.length <= 3) return '(' + usDigits;
    if (usDigits.length <= 6) return '(' + usDigits.slice(0, 3) + ') ' + usDigits.slice(3);
    return '(' + usDigits.slice(0, 3) + ') ' + usDigits.slice(3, 6) + '-' + usDigits.slice(6, 10);
  }

  function normalizePhone(raw) {
    const value = String(raw || '').trim();
    const digits = value.replace(/\D/g, '');
    const normalized = digits.length === 10 ? '+1' + digits : digits.length === 11 && digits.startsWith('1') ? '+' + digits : '+' + digits;
    return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : '';
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, variant) {
    const node = element('button', 'ym-button ' + variant, label);
    node.type = 'button';
    return node;
  }

  function message(form) {
    if (state.error) {
      const node = element('p', 'ym-error', state.error);
      node.setAttribute('role', 'alert');
      form.append(node);
    } else if (state.status) {
      const node = element('p', 'ym-status', state.status);
      node.setAttribute('role', 'status');
      form.append(node);
    }
  }

  function render() {
    if (!root) return;
    root.replaceChildren();
    const backdrop = element('div', 'ym-backdrop');
    const panel = element('section', 'ym-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'yesmore-preview-title');

    const close = element('button', 'ym-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close sign-up');
    close.addEventListener('click', closeSurface);
    panel.append(close, element('p', 'ym-kicker', 'YesMore account'));

    const title = element(
      'h2',
      'ym-title',
      state.step === 'phone' ? 'Join YesMore' : state.step === 'code' ? 'Check your messages' : 'You are ready',
    );
    title.id = 'yesmore-preview-title';
    panel.append(title);
    panel.append(element(
      'p',
      'ym-description',
      state.step === 'phone'
        ? 'Enter your phone number and we will simulate a secure sign-in code.'
        : state.step === 'code'
          ? 'Enter any 4–10 digit code. This local preview sends nothing.'
          : 'Mock verification passed. Production would continue to /me on the configured application origin.',
    ));

    if (state.step === 'success') {
      const done = button('Close preview', 'ym-primary');
      done.addEventListener('click', closeSurface);
      const wrap = element('div', 'ym-form');
      wrap.append(done, element('p', 'ym-privacy', 'No session or remote handoff was created.'));
      panel.append(wrap);
    } else {
      const form = element('form', 'ym-form');
      form.noValidate = true;
      const label = element('label', 'ym-field');
      const labelText = element('span', '', state.step === 'phone' ? 'Phone number' : 'Verification code');
      const input = element('input', 'ym-input');
      input.name = state.step === 'phone' ? 'phone' : 'code';
      input.type = state.step === 'phone' ? 'tel' : 'text';
      input.inputMode = state.step === 'phone' ? 'tel' : 'numeric';
      input.autocomplete = state.step === 'phone' ? 'tel' : 'one-time-code';
      input.placeholder = state.step === 'phone' ? '(415) 555-0123' : '000000';
      input.value = state.step === 'phone' ? state.phoneDisplay : state.code;
      input.disabled = state.busy;
      input.addEventListener('input', () => {
        if (state.step === 'phone') {
          state.phoneDisplay = formatPhone(input.value);
          input.value = state.phoneDisplay;
        } else {
          state.code = input.value.replace(/\D/g, '').slice(0, 10);
          input.value = state.code;
        }
      });
      label.append(labelText, input);
      form.append(label);

      const primary = button(
        state.busy
          ? state.step === 'phone' ? 'Sending…' : 'Checking…'
          : state.step === 'phone' ? 'Text me a code' : 'Continue to YesMore',
        'ym-primary',
      );
      primary.type = 'submit';
      primary.disabled = state.busy;
      primary.setAttribute('aria-busy', String(state.busy));
      form.append(primary);
      message(form);

      if (state.step === 'code') {
        const subactions = element('div', 'ym-subactions');
        const change = button('Change number', 'ym-secondary');
        const resend = button('Send a new code', 'ym-secondary');
        change.disabled = state.busy;
        resend.disabled = state.busy;
        change.addEventListener('click', () => {
          state.step = 'phone';
          state.code = '';
          state.error = '';
          state.status = '';
          record('change number', 'returned to the mock phone step');
          render();
        });
        resend.addEventListener('click', () => {
          state.error = '';
          state.status = '';
          state.busy = true;
          record('resend', 'mock action recorded; no SMS sent');
          render();
          const generation = surfaceGeneration;
          setTimeout(() => {
            if (generation !== surfaceGeneration || root?.hidden) return;
            state.busy = false;
            state.status = 'A mock code was sent. No SMS left this device.';
            render();
          }, 500);
        });
        subactions.append(change, resend);
        form.append(subactions);
      }

      form.append(element(
        'p',
        'ym-privacy',
        'Local mock only. No network request, SMS, session, or handoff can occur.',
      ));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        state.error = '';
        state.status = '';
        if (state.step === 'phone') {
          const phone = normalizePhone(state.phoneDisplay);
          if (!phone) {
            state.error = 'Enter a valid phone number.';
            record('send code', 'mock validation failed');
            render();
            return;
          }
          state.phone = phone;
          state.busy = true;
          record('send code', 'mock action recorded; no SMS sent');
          render();
          const generation = surfaceGeneration;
          setTimeout(() => {
            if (generation !== surfaceGeneration || root?.hidden) return;
            state.busy = false;
            state.step = 'code';
            render();
          }, 500);
          return;
        }
        if (!/^\d{4,10}$/.test(state.code)) {
          state.error = 'Enter the verification code.';
          record('verify code', 'mock validation failed');
          render();
          return;
        }
        state.busy = true;
        record('verify code', 'mock action recorded; no session or handoff created');
        render();
        const generation = surfaceGeneration;
        setTimeout(() => {
          if (generation !== surfaceGeneration || root?.hidden) return;
          state.busy = false;
          state.step = 'success';
          render();
        }, 500);
      });
      panel.append(form);
    }

    backdrop.append(panel);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeSurface();
    });
    root.append(backdrop);
    requestAnimationFrame(() => {
      (root.querySelector('input') || root.querySelector('button'))?.focus();
    });
  }

  function openSurface(trigger) {
    if (root && !root.hidden) return;
    surfaceGeneration += 1;
    lastTrigger = trigger;
    state = initialState();
    root.hidden = false;
    activity.inert = true;
    inertEntries = [...document.body.children]
      .filter((node) => node !== host)
      .map((node) => ({ node, inert: node.inert }));
    for (const entry of inertEntries) entry.node.inert = true;
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    record('sign-up', 'trusted local mock opened');
    render();
  }

  function closeSurface() {
    if (!root || root.hidden) return;
    surfaceGeneration += 1;
    root.hidden = true;
    activity.inert = false;
    root.replaceChildren();
    document.documentElement.style.overflow = previousOverflow;
    for (const entry of inertEntries) entry.node.inert = entry.inert;
    inertEntries = [];
    const trigger = lastTrigger;
    lastTrigger = undefined;
    trigger?.focus();
    record('sign-up', 'trusted local mock closed');
  }

  function rejected(name) {
    return () => {
      record(name, 'blocked; no network request was sent');
      return Promise.reject(new Error(name + ' is blocked in the YesMore local preview'));
    };
  }

  Object.defineProperty(window, 'fetch', { configurable: false, value: rejected('fetch') });
  for (const name of ['XMLHttpRequest', 'EventSource', 'WebSocket', 'Worker', 'SharedWorker']) {
    Object.defineProperty(window, name, {
      configurable: false,
      value: class {
        constructor() {
          record(name, 'blocked; no network request was sent');
          throw new Error(name + ' is blocked in the YesMore local preview');
        }
      }
    });
  }
  try {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: false,
      value: () => {
        record('sendBeacon', 'blocked; no network request was sent');
        return false;
      }
    });
  } catch {}
  Object.defineProperty(window, 'open', {
    configurable: false,
    value: () => {
      record('window.open', 'blocked; no window was opened');
      return null;
    }
  });

  document.addEventListener('click', (event) => {
    const trigger = event.composedPath().find(
      (node) => node instanceof HTMLButtonElement && node.matches(signUpSelector),
    );
    if (trigger && !trigger.disabled && trigger.getAttribute('aria-disabled') !== 'true') {
      event.preventDefault();
      event.stopImmediatePropagation();
      openSurface(trigger);
      return;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link && !link.getAttribute('href')?.startsWith('#')) {
      event.preventDefault();
      record('link navigation', 'blocked; no network request was sent');
    }
  }, true);

  document.addEventListener('submit', (event) => {
    if (root && event.composedPath().includes(root)) return;
    event.preventDefault();
    record('form submission', 'blocked; no navigation or network request was sent');
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!root || root.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSurface();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = shadow.activeElement;
    if (!root.contains(activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  addEventListener('DOMContentLoaded', () => {
    host = document.createElement('yesmore-preview-host');
    host.id = '${previewHostId}';
    host.style.setProperty('all', 'initial', 'important');
    for (const [property, value] of [
      ['display', 'block'],
      ['visibility', 'visible'],
      ['opacity', '1'],
      ['pointer-events', 'auto'],
      ['transform', 'none'],
      ['filter', 'none'],
      ['clip-path', 'none'],
      ['content-visibility', 'visible'],
      ['contain', 'none'],
      ['position', 'static'],
    ]) host.style.setProperty(property, value, 'important');
    shadow = host.attachShadow({ mode: 'open' });
    const styles = document.createElement('style');
    styles.textContent = ${JSON.stringify(previewStyles)};
    shadow.append(styles);

    root = document.createElement('div');
    root.className = 'ym-root';
    root.hidden = true;
    shadow.append(root);

    activity = document.createElement('details');
    activity.className = 'ym-activity';
    const summary = document.createElement('summary');
    summary.textContent = 'YesMore mock · ready';
    const body = document.createElement('div');
    body.append('No SMS, network request, session, or remote handoff can occur.');
    const output = document.createElement('pre');
    output.className = 'ym-log';
    output.setAttribute('aria-live', 'polite');
    activitySummary = summary;
    activityOutput = output;
    body.append(output);
    activity.append(summary, body);
    shadow.append(activity);
    document.body.append(host);
    record('preview', 'declarative sign-up mock ready');
  });
})();
</script>`;

function injectPreview(html, headEnd) {
  return html.slice(0, headEnd) + injectedRuntime + html.slice(headEnd);
}

function openBrowser(url) {
  if (process.env.YESMORE_PREVIEW_NO_OPEN === '1') return;
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => process.stderr.write('Preview is ready; open ' + url + ' manually.\n'));
  child.unref();
}

if (process.argv.length !== 3) {
  fail('usage: preview-bundle.mjs <path-to-index.html>');
}

let source;
let headEnd;
try {
  ({ html: source, headEnd } = validateDocument(await readFile(process.argv[2])));
} catch (error) {
  fail(error instanceof Error ? error.message : 'could not validate index.html.');
}

const previewHtml = injectPreview(source, headEnd);
const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts allow-forms allow-modals',
].join('; ');

const server = createServer((request, response) => {
  const address = server.address();
  const expectedHost = address && typeof address === 'object'
    ? '127.0.0.1:' + address.port
    : '';
  if (request.headers.host !== expectedHost) {
    response.writeHead(421, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('Misdirected request.');
    return;
  }
  if (request.method === 'GET' && request.url === '/favicon.ico') {
    response.writeHead(204, { 'Cache-Control': 'no-store', 'Content-Security-Policy': csp });
    response.end();
    return;
  }
  if (request.method !== 'GET' || request.url !== '/') {
    response.writeHead(404, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp,
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('Not found.');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp,
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(previewHtml);
});

server.on('error', (error) => fail(error.message));
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const url = 'http://127.0.0.1:' + address.port + '/';
  process.stdout.write('YesMore local preview: ' + url + '\nPress Ctrl-C to stop.\n');
  openBrowser(url);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGHUP', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
