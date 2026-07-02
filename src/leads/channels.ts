/**
 * Channel verification + routing — the gate between Clay enrichment and the two
 * outbound channels (Instantly cold email, Bulut's cold-call dialer).
 *
 * Encodes the lesson from the Apollo/Clay data-pipeline research: a contact is NOT
 * one blob. Each channel (email, phone) carries its OWN verification state, and a
 * lead is only "ready" for a channel when THAT channel is validated. The founder's
 * #1 cold-call pain — reaching a company switchboard / reception, numbers that never
 * pick up — is exactly an unvalidated, non-direct phone being dialed. So:
 *
 *   - dial_ready  requires a MOBILE or DIRECT DIAL that isn't known-bad. An HQ /
 *                 switchboard / main / reception number NEVER qualifies.
 *   - email_ready requires a deliverable (valid) email. Catch-all / risky is held
 *                 back (it's the bounce source), invalid/unknown never sends.
 *
 * Pure functions, no I/O — fed by the Clay webhook at ingest and re-derivable from a
 * stored lead at export time. Routing decisions live in raw_payload, so no DB
 * migration is needed.
 */

export type EmailVerif = 'valid' | 'risky' | 'invalid' | 'unknown';
export type PhoneType = 'mobile' | 'direct_dial' | 'hq' | 'unknown';
export type PhoneVerif = 'valid' | 'invalid' | 'unknown';
export type Channel = 'email' | 'call';

export type ChannelRouting = {
  email: string | null;
  email_verif: EmailVerif;
  phone: string | null;
  phone_type: PhoneType;
  phone_verif: PhoneVerif;
  email_ready: boolean;
  dial_ready: boolean;
  routed_to: Channel[];
};

const lc = (v: unknown): string => (v == null ? '' : String(v)).toLowerCase().trim();
const str = (v: unknown): string | null => { const s = v == null ? '' : String(v).trim(); return s || null; };

/** First non-empty string among several candidate keys on a record. */
function firstOf(r: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) { const v = str(r[k]); if (v) return v; }
  return null;
}

/**
 * Normalize the many provider labels for email deliverability into 4 states.
 * Clay's email-verification waterfall returns things like "valid", "catch_all",
 * "accept_all", "risky", "unknown", "invalid", "do_not_mail", "disposable".
 */
export function classifyEmail(raw: unknown): EmailVerif {
  const s = lc(raw);
  if (!s) return 'unknown';
  if (/(^|[^a-z])(valid|deliverable|safe|ok|ultra|verified|clay_verified)([^a-z]|$)/.test(s)) {
    // "invalid"/"undeliverable" must not be caught by the "valid"/"deliverable" stem
    if (/(invalid|undeliverable|not_?deliverable)/.test(s)) return 'invalid';
    return 'valid';
  }
  if (/(catch[_\s-]?all|accept[_\s-]?all|risky|risk|unknown_quality|greylist|disposable|role|do[_\s-]?not[_\s-]?mail)/.test(s)) return 'risky';
  if (/(invalid|undeliverable|bounce|bounced|bad|dead|failed|reject)/.test(s)) return 'invalid';
  if (/(unverified|needs_?lookup|not_?checked|pending|none)/.test(s)) return 'unknown';
  return 'unknown';
}

/**
 * Line type for a phone number. The decisive split for cold calling is
 * direct (mobile / direct dial) vs HQ (main / switchboard / reception / company).
 * Providers label this as line_type / number_type / phone_type with values like
 * "mobile", "cell", "direct", "direct_dial", "landline", "voip", "hq", "main",
 * "switchboard", "company", "office", "work".
 */
export function classifyPhoneType(raw: unknown, fieldNameHint = ''): PhoneType {
  const s = lc(raw) || lc(fieldNameHint);
  if (!s) return 'unknown';
  if (/(mobile|cell|cellular|personal)/.test(s)) return 'mobile';
  if (/(direct[_\s-]?dial|direct|ddi)/.test(s)) return 'direct_dial';
  if (/(hq|head[_\s-]?quarter|main|switch[_\s-]?board|reception|company|corporate|office|work|landline|general)/.test(s)) return 'hq';
  if (/voip/.test(s)) return 'direct_dial'; // a person's VoIP DID is reachable; treat as direct
  return 'unknown';
}

/** Phone live-validity, when a provider supplies it (connected/active vs disconnected). */
export function classifyPhoneVerif(raw: unknown): PhoneVerif {
  const s = lc(raw);
  if (!s) return 'unknown';
  if (/(invalid|disconnected|not[_\s-]?in[_\s-]?service|dead|bad|unreachable|fail)/.test(s)) return 'invalid';
  if (/(valid|connected|active|verified|reachable|live|ok|true|yes)/.test(s)) return 'valid';
  return 'unknown';
}

/**
 * Extract email + phone channels from a raw Clay webhook record and route the lead.
 * Reads the wide range of field names Clay sources can emit. To get phone TYPE +
 * validation into the engine, the Clay table must surface them (see build spec):
 *   phone | mobile_phone | direct_phone | work_phone   (the number)
 *   phone_type | line_type | number_type               (mobile vs hq)
 *   phone_status | phone_validation | phone_verified    (connected vs dead)
 *   email_status | email_verification | email_deliverability
 */
export function channelsFromRecord(r: Record<string, unknown>): ChannelRouting {
  const email = str(r.email)?.toLowerCase() ?? null;
  const email_verif = classifyEmail(
    firstOf(r, ['email_status', 'email_verification', 'email_deliverability', 'email_state', 'email_result']),
  );

  // Prefer an explicitly-typed direct number, then fall back through the rest.
  const mobile = firstOf(r, ['mobile_phone', 'mobile', 'cell', 'cell_phone', 'personal_phone']);
  const direct = firstOf(r, ['direct_phone', 'direct_dial', 'direct']);
  const generic = firstOf(r, ['phone', 'phone_number']);
  const workish = firstOf(r, ['work_phone', 'company_phone', 'office_phone', 'hq_phone']);
  const phone = mobile ?? direct ?? generic ?? workish;

  // Determine the type: an explicit provider label wins; otherwise infer from which
  // field the number arrived in (a number that only came in as work_phone is HQ).
  const typeLabel = firstOf(r, ['phone_type', 'line_type', 'number_type', 'phone_line_type']);
  let phone_type: PhoneType = classifyPhoneType(typeLabel);
  if (phone_type === 'unknown') {
    if (mobile) phone_type = 'mobile';
    else if (direct) phone_type = 'direct_dial';
    else if (workish && !generic) phone_type = 'hq';
  }
  const phone_verif = classifyPhoneVerif(
    firstOf(r, ['phone_status', 'phone_validation', 'phone_verified', 'phone_state', 'phone_result']),
  );

  return route({ email, email_verif, phone, phone_type, phone_verif });
}

/** Re-derive routing from already-stored lead fields (export / dashboard / backfill). */
export function channelsFromLead(rp: Record<string, unknown>, email: string | null, emailStatus: string | null): ChannelRouting {
  const phone = (str(rp.clay_phone) ?? str(rp.phone)) || null;
  return route({
    email: email?.toLowerCase() ?? null,
    email_verif: classifyEmail(rp.email_verif ?? emailStatus),
    phone,
    phone_type: classifyPhoneType(rp.clay_phone_type ?? rp.phone_type),
    phone_verif: classifyPhoneVerif(rp.clay_phone_verif ?? rp.phone_verif),
  });
}

/** The routing rule itself — the single place "ready" is decided. */
export function route(c: Omit<ChannelRouting, 'email_ready' | 'dial_ready' | 'routed_to'>): ChannelRouting {
  // Email: only a deliverable address sends. Risky (catch-all) is held back — it is
  // the bounce source the founder flagged; surface it but don't auto-enroll.
  const email_ready = Boolean(c.email) && c.email_verif === 'valid';
  // Call: must be a DIRECT line (mobile or direct dial) that isn't known-dead. An HQ /
  // switchboard number is never dial_ready — that's the "reached reception" failure.
  const isDirect = c.phone_type === 'mobile' || c.phone_type === 'direct_dial';
  const dial_ready = Boolean(c.phone) && isDirect && c.phone_verif !== 'invalid';
  const routed_to: Channel[] = [];
  if (email_ready) routed_to.push('email');
  if (dial_ready) routed_to.push('call');
  return { ...c, email_ready, dial_ready, routed_to };
}

/** The raw_payload patch to persist a routing decision on a lead. */
export function routingPayload(c: ChannelRouting, now: string): Record<string, unknown> {
  return {
    clay_phone: c.phone,
    clay_phone_type: c.phone_type,
    clay_phone_verif: c.phone_verif,
    email_verif: c.email_verif,
    dial_ready: c.dial_ready,
    email_ready: c.email_ready,
    routed_to: c.routed_to,
    routed_at: now,
  };
}
