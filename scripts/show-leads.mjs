#!/usr/bin/env node
/**
 * Prints what lead intake actually stored: the referral, the contact it resolved
 * to, and the conversation waiting on it.
 *
 * Phone numbers are masked — they are personal data and must not be pasted into
 * a chat or an issue. Everything else is shown as stored, including the raw form
 * answers, which is where the field keys needed for the consent and screening
 * mapping can be read.
 */
import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

const rows = await sql`
  SELECT r.external_lead_id,
         r.form_id,
         r.ad_id,
         r.received_at,
         r.raw_payload,
         c.name,
         c.phone,
         c.email,
         c.entry_point,
         c.consent_status,
         c.consent_source,
         c.consent_text,
         c.do_not_contact,
         v.id    AS conversation_id,
         v.stage
  FROM campaign_referrals r
  JOIN contacts c ON c.id = r.contact_id
  LEFT JOIN conversations v ON v.contact_id = c.id
  WHERE r.external_lead_id IS NOT NULL
  ORDER BY r.received_at DESC
  LIMIT 10
`;

if (rows.length === 0) {
  console.log('No lead-form referrals stored yet.');
  console.log('\nIf you expected one, check the server log for the webhook response.');
  await sql.end();
  process.exit(0);
}

const mask = (p) =>
  p && p.length > 4 ? `${'*'.repeat(p.length - 4)}${p.slice(-4)}` : '***';

for (const row of rows) {
  console.log('─'.repeat(72));
  console.log(`lead ${row.external_lead_id}   received ${row.received_at.toISOString()}`);
  console.log(`  form ${row.form_id ?? '—'}   ad ${row.ad_id ?? '—'}`);
  console.log(
    `  contact:  ${row.name ?? '(no name)'}  ${mask(row.phone)}  ${row.email ?? ''}`,
  );
  console.log(`  entry:    ${row.entry_point}`);
  console.log(
    `  consent:  ${row.consent_status}` +
      (row.consent_source ? `  (source ${row.consent_source})` : '') +
      (row.consent_text ? `  evidence "${row.consent_text}"` : ''),
  );
  console.log(`  dnc:      ${row.do_not_contact}`);
  console.log(`  stage:    ${row.stage ?? '(no conversation)'}`);

  // The form's own field keys live here. These are what the consent gate and the
  // screening pre-fill need to be configured against.
  const fieldData = row.raw_payload?.field_data;
  if (Array.isArray(fieldData)) {
    console.log('  form fields (key -> value):');
    for (const f of fieldData) {
      const value = (f.values ?? []).join(', ');
      const shown = /phone|email/i.test(f.name ?? '') ? '«hidden»' : value;
      console.log(`    ${f.name} -> ${shown}`);
    }
  }
}
console.log('─'.repeat(72));
console.log(`\n${rows.length} referral(s).`);
console.log(
  '\nconsent_status is privacy_policy_only until META_LEAD_CONSENT_FIELD names\n' +
    'the consent key above. That is intended — see docs/PRODUCT-REQUIREMENTS.md NN-2.',
);

await sql.end();
