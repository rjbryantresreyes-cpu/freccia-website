/**
 * ghl-lead — relays Netlify form submissions into GoHighLevel.
 *
 * WHY THIS EXISTS
 * Website forms are Netlify Forms. They store the submission and fire email
 * notifications, and that is the whole path — it ends at an inbox. GHL never
 * hears about them, so website enquiries produced no CRM record, no pipeline
 * entry and no follow-up. Two real leads (2026-09-01) sat unactioned because
 * of exactly that. Netlify cannot call GHL directly because its outgoing
 * webhooks cannot send an Authorization header, so this relay is required.
 *
 * DELIBERATE: TAGS ARE `score-` PREFIXED ONLY.
 * Freccia's GHL has live workflows that trigger on `new lead - commercial`,
 * `cold lead - commercial` and `commercial-form-submitted`. Applying any of
 * those here would fire Welcome/Re-engage at a prospect who is also being
 * emailed by Josh, and would stack a second internal alert on top of the
 * Netlify notification. This function therefore creates a PASSIVE record.
 * Wiring the automation is a separate decision that depends on settling who
 * notifies Josh — see the open-items doc.
 *
 * Always returns 200. A non-2xx makes Netlify retry, which would duplicate
 * contacts; failures are logged instead and are visible in function logs.
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

function ghlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// Netlify posts the submission with fields under `data`, but shapes have
// varied across their webhook versions. Accept either.
function readFields(payload) {
  const d = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  return {
    email: pick('email', 'Email', 'email_address'),
    firstName: pick('first_name', 'firstName', 'First Name', 'fname'),
    lastName: pick('last_name', 'lastName', 'Last Name', 'lname'),
    fullName: pick('name', 'full_name', 'Name'),
    phone: pick('phone', 'Phone', 'phone_number'),
    projectType: pick('project_type', 'projectType', 'Project Type'),
    budget: pick('budget', 'Budget'),
    message: pick('message', 'Message', 'comments', 'details'),
    referrer: pick('referrer', 'Referrer'),
  };
}

function splitName(f) {
  if (f.firstName || f.lastName) return { firstName: f.firstName, lastName: f.lastName };
  if (!f.fullName) return { firstName: '', lastName: '' };
  const parts = f.fullName.split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// GHL rejects anything that is not E.164-ish. A bad phone fails the whole
// contact create, so drop it rather than lose the lead over a phone number.
//
// The old catch-all branch here returned `+${digits}` for ANY 8-15 digit
// string, which defeated that intent instead of serving it. A local-format
// number with a national trunk prefix ("09363936540") became "+09363936540",
// and there is no country calling code 0, so GHL answered
// 400 "Invalid country calling code" and the whole create died -- no contact,
// no note, no opportunity. Submissions #52 and #53 were lost exactly that way
// on 2026-09-16, and leading-zero local format is the norm in the PH, the UK,
// Australia and most of Europe.
//
// So a number is only trusted when we can say what country it belongs to:
// a 10-digit NANP number, an 11-digit one starting with 1, or one the person
// actually wrote in international form themselves. Everything else is dropped
// -- and `buildNote` still records it verbatim as "Phone as entered", so the
// number reaches Josh either way.
function normalisePhone(raw) {
  if (!raw) return undefined;
  const wroteInternational = /^\s*\+/.test(raw);
  const digits = raw.replace(/\D/g, '');
  // A NANP area code never begins with 0 or 1, so a 10-digit string that does
  // is not a US number and must not be given a +1. Without this, a trimmed
  // local number like "0207 946 095" would silently become "+10207946095".
  if (digits.length === 10 && !/^[01]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (wroteInternational && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) {
    return `+${digits}`;
  }
  return undefined;
}

function buildNote(payload, f) {
  const when = payload.created_at || new Date().toISOString();
  const lines = [
    'WEBSITE ENQUIRY (via Netlify form relay)',
    `Form: ${payload.form_name || 'unknown'}`,
    `Submitted: ${when}`,
  ];
  if (f.projectType) lines.push(`Project type: ${f.projectType}`);
  if (f.budget) lines.push(`Budget: ${f.budget}`);
  if (f.phone) lines.push(`Phone as entered: ${f.phone}`);
  if (f.referrer) lines.push(`Page: ${f.referrer}`);
  lines.push('', 'Message:', f.message || '(no message submitted)');
  return lines.join('\n');
}

// Commercial Pipeline / "New Lead" stage. Hard-coded rather than looked up:
// there is exactly one pipeline on this sub-account and a lookup would add a
// round trip plus a failure mode on every submission.
const PIPELINE_ID = 'BtRChioUYaBNx8wLfAMI';
const NEW_LEAD_STAGE_ID = 'de49f61e-6e56-4c23-b03a-59ba87e3142e';

/**
 * Turns the form's budget band into an opportunity value.
 *
 * Uses the LOW end of the band the prospect selected, never a midpoint or an
 * invented figure. "500k-1m" becomes 500000. The exact band is also written
 * verbatim into the note, so the funnel stays conservative while the real
 * answer remains visible on the record. Unrecognised or absent budget gives
 * 0 rather than a guess.
 *
 * The six bands the contact form actually offers, and what this returns:
 *   under-200k -> 0        200k-500k -> 200000    500k-1m -> 500000
 *   1m-2m      -> 1000000  2m-5m     -> 2000000   5m+     -> 5000000
 */
function budgetToValue(budget) {
  if (!budget) return 0;
  const s = String(budget).toLowerCase();
  // An open-ended LOWER band has a low end of zero, not the number it names.
  // The contact form offers "under-200k", and matching its digits returns the
  // band's HIGH end (200000) — the exact opposite of this function's contract,
  // and it overstates the funnel. Checked before the digit match, deliberately.
  // Note the reverse is NOT a bug: "5m+" and "over-5m" have a low end of 5m,
  // so they fall through and return 5000000 correctly.
  if (/\b(under|below|less\s*than|up\s*to)\b|^\s*</.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*([km])/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return 0;
  return Math.round(n * (m[2] === 'm' ? 1000000 : 1000));
}

// Do not stack a second opportunity on someone who already has one open. A
// repeat enquiry from an existing prospect should land as a note on the
// record they already have, not as a duplicate row in Rebekah's funnel.
async function hasOpenOpportunity(token, locationId, contactId) {
  try {
    const url =
      `${GHL_BASE}/opportunities/search?location_id=${encodeURIComponent(locationId)}` +
      `&contact_id=${encodeURIComponent(contactId)}&status=open&limit=1`;
    const res = await fetch(url, { headers: ghlHeaders(token) });
    if (!res.ok) return false;
    const j = await res.json().catch(() => ({}));
    return Array.isArray(j.opportunities) && j.opportunities.length > 0;
  } catch (e) {
    console.error('relay: opportunity lookup threw', e && e.message);
    return false; // fail open: a missing opportunity is worse than a duplicate
  }
}

exports.handler = async (event) => {
  const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const sharedSecret = process.env.GHL_RELAY_SECRET;

  if (!token || !locationId) {
    console.error('relay misconfigured: GHL_API_KEY or GHL_LOCATION_ID missing');
    return ok({ relayed: false, reason: 'missing-credentials' });
  }

  // Netlify outgoing webhooks cannot send custom headers, so the shared
  // secret rides in the query string. Without this, anyone who found the URL
  // could inject contacts into the client's CRM.
  if (sharedSecret) {
    const provided = (event.queryStringParameters || {}).key;
    if (provided !== sharedSecret) {
      console.warn('relay rejected: bad or missing key');
      return { statusCode: 401, body: 'unauthorized' };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('relay: unparseable body');
    return ok({ relayed: false, reason: 'bad-json' });
  }

  const f = readFields(payload);
  if (!f.email) {
    console.warn('relay: submission had no email, skipping', payload.form_name);
    return ok({ relayed: false, reason: 'no-email' });
  }

  const { firstName, lastName } = splitName(f);
  const phone = normalisePhone(f.phone);
  const formName = payload.form_name || 'contact';

  const tags = ['score-website-form', `score-form-${formName}`.slice(0, 60)];
  if (f.budget) tags.push(`score-budget-${f.budget}`.slice(0, 60));

  const body = {
    locationId,
    email: f.email,
    source: `Website form: ${formName}`,
    tags,
  };
  if (firstName) body.firstName = firstName;
  if (lastName) body.lastName = lastName;
  if (phone) body.phone = phone;

  let contactId = null;
  let created = false;
  let phoneDropped = false;

  const postContact = async (payload) => {
    const r = await fetch(`${GHL_BASE}/contacts/`, {
      method: 'POST',
      headers: ghlHeaders(token),
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    return { res: r, json: j };
  };

  try {
    let { res, json } = await postContact(body);

    // The phone is the one field that can 400 the entire create, and the
    // enquiry is worth far more than the phone number. Rather than predict
    // every shape GHL dislikes, retry once without it whenever a rejection
    // even mentions the phone. `normalisePhone` above already blocks the
    // known leading-zero case; this catches the next one we have not seen.
    // The raw number still reaches Josh via the note and the Netlify email.
    if (!res.ok && body.phone && /phone|calling code/i.test(JSON.stringify(json))) {
      console.warn(
        'relay: create rejected on phone, retrying without it',
        res.status,
        JSON.stringify(json).slice(0, 200)
      );
      const retryBody = { ...body };
      delete retryBody.phone;
      ({ res, json } = await postContact(retryBody));
      phoneDropped = res.ok;
    }

    if (res.ok) {
      contactId = (json.contact && json.contact.id) || json.id || null;
      created = true;
    } else {
      // A duplicate is a success for our purposes: the person is already in
      // the CRM and the note still needs to land on them.
      contactId =
        (json.meta && json.meta.contactId) ||
        (json.meta && json.meta.matchingField && json.meta.contactId) ||
        null;
      if (!contactId) {
        console.error('relay: GHL create failed', res.status, JSON.stringify(json).slice(0, 500));
        return ok({ relayed: false, reason: 'ghl-create-failed', status: res.status });
      }
      console.log('relay: existing contact matched', contactId);
    }
  } catch (e) {
    console.error('relay: GHL create threw', e && e.message);
    return ok({ relayed: false, reason: 'ghl-create-threw' });
  }

  // The message is the entire value of the enquiry. A contact with no note is
  // a name with no context, so a note failure is logged loudly.
  let noted = false;
  if (contactId) {
    try {
      const nres = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
        method: 'POST',
        headers: ghlHeaders(token),
        body: JSON.stringify({ body: buildNote(payload, f) }),
      });
      noted = nres.ok;
      if (!nres.ok) {
        const t = await nres.text().catch(() => '');
        console.error('relay: note failed', nres.status, t.slice(0, 300));
      }
    } catch (e) {
      console.error('relay: note threw', e && e.message);
    }
  }

  // The Opportunity is what actually puts the lead in Rebekah's funnel. The
  // contact alone is invisible there. This is created directly rather than by
  // applying `commercial-form-submitted` and letting Commercial - New Lead
  // Capture do it, because that tag's other listeners cannot be inventoried
  // from the API and Welcome Email v2 is still published. Firing it could send
  // an automated welcome to a prospect Josh is already replying to.
  let opportunityId = null;
  if (contactId) {
    try {
      if (await hasOpenOpportunity(token, locationId, contactId)) {
        console.log('relay: contact already has an open opportunity, not duplicating');
      } else {
        const who = [firstName, lastName].filter(Boolean).join(' ') || f.email;
        const ores = await fetch(`${GHL_BASE}/opportunities/`, {
          method: 'POST',
          headers: ghlHeaders(token),
          body: JSON.stringify({
            pipelineId: PIPELINE_ID,
            pipelineStageId: NEW_LEAD_STAGE_ID,
            locationId,
            contactId,
            name: `${who} - Website Enquiry`,
            status: 'open',
            monetaryValue: budgetToValue(f.budget),
          }),
        });
        const oj = await ores.json().catch(() => ({}));
        if (ores.ok) {
          opportunityId = (oj.opportunity && oj.opportunity.id) || oj.id || null;
        } else {
          console.error('relay: opportunity create failed', ores.status, JSON.stringify(oj).slice(0, 400));
        }
      }
    } catch (e) {
      console.error('relay: opportunity threw', e && e.message);
    }
  }

  console.log(
    `relay ok form=${formName} contact=${contactId} created=${created} noted=${noted} opp=${opportunityId} phoneDropped=${phoneDropped}`
  );
  return ok({ relayed: true, contactId, created, noted, opportunityId, phoneDropped });
};
