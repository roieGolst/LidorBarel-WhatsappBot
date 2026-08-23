#!/usr/bin/env node
/**
 * Sends a correctly-signed Meta `leadgen` webhook to a locally running server.
 *
 * This exercises the real path end to end — signature verification, envelope
 * dispatch, Graph retrieval, and persistence — without needing a public tunnel
 * or Meta's testing tool. The only thing it simulates is Meta's delivery; the
 * lead itself is fetched from the real Graph API, so the `leadgen_id` must be a
 * real one from your form.
 *
 * Get a real id with:
 *   curl -s -G "https://graph.facebook.com/v21.0/<FORM_ID>/leads" \
 *     -d "fields=id,created_time,field_data" \
 *     -H "Authorization: Bearer $META_PAGE_ACCESS_TOKEN"
 *
 * Usage:
 *   node scripts/send-test-leadgen.mjs <leadgen_id> [--form-id ID] [--page-id ID]
 *                                      [--url http://localhost:3000/webhooks/whatsapp]
 */
import { createHmac } from 'node:crypto';
import 'dotenv/config';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const leadgenId = positional[0];
if (!leadgenId) {
  console.error('usage: node scripts/send-test-leadgen.mjs <leadgen_id> [--form-id ID]');
  process.exit(1);
}

const appSecret = process.env.META_APP_SECRET;
if (!appSecret) {
  console.error('META_APP_SECRET is not set — the server would reject this with 403.');
  process.exit(1);
}
if (!process.env.META_PAGE_ACCESS_TOKEN) {
  console.warn(
    'warning: META_PAGE_ACCESS_TOKEN is not set. The server will answer 503 ' +
      '(fail closed) because it cannot retrieve the lead.\n',
  );
}

const url = flag('url', `http://localhost:${process.env.PORT ?? 3000}/webhooks/whatsapp`);
const now = Math.floor(Date.now() / 1000);

const body = {
  object: 'page',
  entry: [
    {
      id: flag('page-id', '000000000000000'),
      time: now,
      changes: [
        {
          field: 'leadgen',
          value: {
            leadgen_id: leadgenId,
            page_id: flag('page-id', '000000000000000'),
            form_id: flag('form-id', ''),
            created_time: now,
          },
        },
      ],
    },
  ],
};

// Meta signs the exact bytes of the body, so sign the same string that is sent.
const payload = JSON.stringify(body);
const signature = `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`;

console.log(`POST ${url}`);
console.log(`leadgen_id: ${leadgenId}\n`);

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  body: payload,
}).catch((err) => {
  console.error(`request failed: ${err.message}`);
  console.error('Is the server running? Try: npm run dev');
  process.exit(1);
});

const text = await response.text();
console.log(`status: ${response.status}${text ? ` — ${text}` : ''}\n`);

const meaning = {
  200: 'Accepted. The lead was stored, was a duplicate, or could never be stored.',
  403: "Signature rejected — META_APP_SECRET here differs from the server's.",
  503: 'Fail-closed: META_PAGE_ACCESS_TOKEN is missing, so the lead cannot be retrieved.',
};
console.log(meaning[response.status] ?? 'Retryable failure — Meta would redeliver.');

if (response.status === 200) {
  console.log('\nVerify what landed:');
  console.log('  npm run leads:show');
}
