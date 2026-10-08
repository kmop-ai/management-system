// CRM vocabulary, owned by the server and imported by the browser and the
// scripts alike, so the list of valid stages and fields cannot drift between
// what the API accepts and what the screens offer.

// Pipeline stages. `ours` says whether the ball is in OUR court at that
// stage: the dashboard counts records whose stage has ours = true, and never
// looks at a stage name. `on_reply` is where an incoming reply MOVES the
// record (the mailbox sync moves records; it does not only store mail).
export const STAGES = [
  { key: 'prospect',      ours: true,  on_reply: 'replied',     label: ['Prospect — to contact', 'Υποψήφιος — για επικοινωνία'] },
  { key: 'contacted',     ours: false, on_reply: 'replied',     label: ['Contacted — waiting for them', 'Επικοινωνήσαμε — περιμένουμε'] },
  { key: 'replied',       ours: true,  on_reply: 'replied',     label: ['They replied — our move', 'Απάντησαν — σειρά μας'] },
  { key: 'in_discussion', ours: false, on_reply: 'replied',     label: ['In discussion — waiting for them', 'Σε συζήτηση — περιμένουμε'] },
  { key: 'partner',       ours: false, on_reply: 'partner',     label: ['Partner', 'Εταίρος'] },
  { key: 'declined',      ours: false, on_reply: 'replied',     label: ['Declined', 'Αρνήθηκαν'] },
  { key: 'dormant',       ours: false, on_reply: 'replied',     label: ['Dormant', 'Ανενεργός'] },
];
export const STAGE_KEYS = STAGES.map(s => s.key);
export const stageOf = (k) => STAGES.find(s => s.key === k) || null;

export const ORG_KINDS = [
  ['ngo', 'NGO / association', 'ΜΚΟ / σύλλογος'],
  ['university', 'University / research', 'Πανεπιστήμιο / έρευνα'],
  ['school', 'School / VET provider', 'Σχολείο / φορέας κατάρτισης'],
  ['public', 'Public authority', 'Δημόσια αρχή'],
  ['company', 'Company', 'Εταιρεία'],
  ['network', 'Network / umbrella', 'Δίκτυο'],
  ['funder', 'Funder / agency', 'Χρηματοδότης / φορέας'],
  ['other', 'Other', 'Άλλο'],
];
export const ORG_KIND_KEYS = ORG_KINDS.map(k => k[0]);

// Fields a person may edit on each record type. Anything else in a request
// is refused. Every field here is tracked in manual_fields once a human
// sets it.
export const ORG_FIELDS = ['name', 'short_name', 'kind', 'country', 'city', 'website', 'general_email', 'decision_maker_name',
  'decision_maker_email', 'decision_maker_id', 'contact_form_url', 'phone', 'pic', 'oid', 'notes', 'stage', 'owner_id'];
export const CONTACT_FIELDS = ['name', 'email', 'phone', 'role_title', 'organisation_id', 'country', 'linkedin_url', 'languages', 'notes', 'stage', 'owner_id'];

// Free and consumer mail providers. When incoming mail is matched to an
// organisation by the sender's DOMAIN, these are excluded — otherwise the
// first contact with a gmail.com address would silently collect every other
// organisation's replies. Exact-address matching still works for them.
export const FREE_MAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.gr', 'hotmail.it', 'hotmail.fr', 'hotmail.es', 'hotmail.co.uk',
  'live.com', 'live.gr', 'msn.com', 'yahoo.com', 'yahoo.gr', 'yahoo.it', 'yahoo.fr', 'yahoo.es', 'yahoo.de', 'yahoo.co.uk', 'ymail.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'libero.it', 'virgilio.it', 'tiscali.it', 'orange.fr', 'wanadoo.fr',
  'free.fr', 'laposte.net', 't-online.de', 'otenet.gr', 'forthnet.gr', 'windowslive.com', 'outlook.gr', 'tutanota.com', 'hey.com',
];
export const isFreeMailDomain = (d) => FREE_MAIL_DOMAINS.includes(String(d || '').toLowerCase());
export const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || null;
