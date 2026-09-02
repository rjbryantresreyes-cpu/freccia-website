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
function normalisePhone(raw) {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
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

  try {
    const res = await fetch(`${GHL_BASE}/contacts/`, {
      method: 'POST',
      headers: ghlHeaders(token),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));

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

  console.log(`relay ok form=${formName} contact=${contactId} created=${created} noted=${noted}`);
  return ok({ relayed: true, contactId, created, noted });
};
