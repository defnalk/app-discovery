/** GET /api/b2b → ADMIN-ONLY B2B company tracker: the B2B counterpart to the
 *  consumer Plays dashboard. Tracks fast-growing B2B software companies (sold to
 *  companies, often not on app stores, e.g. Slack/web/API) that 8x could help or
 *  replicate. Double-gated like /api/admin: signed-token role must be admin AND
 *  the name must be in PLAY_ADMINS, so newly-onboarded managers never see it.
 *
 *  Data is a hand-maintained SEED for now. The live sourcing pipeline (TechCrunch /
 *  web scrapers + research prompts, the "next week" exploration) will replace SEED
 *  with a Supabase-backed table without changing this contract. `signal` is a 0-100
 *  traction-heat estimate; ARR/customer figures are approximate public estimates. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSession, isAdminName, json } from './_lib.ts';

type B2BCompany = {
  name: string; category: string; channel: string;
  arr: string; customers: string; signal: number; url: string; note: string;
};

// Seed set — fast-growing B2B software companies (figures approximate / public est.).
// Victor.ai and Listen Labs are the examples called out by the team; the rest are
// well-known recent B2B rockets. Replace with live-sourced data when the pipeline lands.
const SEED: B2BCompany[] = [
  { name: 'Cursor (Anysphere)', category: 'AI coding / IDE', channel: 'Desktop IDE', arr: '~$300M ARR', customers: 'Devs + eng teams', signal: 98, url: 'https://cursor.com', note: 'Fastest SaaS to $100M+; default AI IDE.' },
  { name: 'Lovable', category: 'AI app builder', channel: 'Web app', arr: '~$80M ARR (~8mo)', customers: 'Builders, SMB', signal: 94, url: 'https://lovable.dev', note: 'Text-to-app; record early ARR ramp.' },
  { name: 'Victor.ai', category: 'AI coworker / agents', channel: 'Slack', arr: '~$20M ARR (~4mo)', customers: '~2,000 customers', signal: 92, url: 'https://victor.ai', note: 'Team callout: ~$20M ARR in 4 months.' },
  { name: 'Glean', category: 'Enterprise AI search', channel: 'Web + connectors', arr: '~$100M ARR', customers: 'Enterprise', signal: 90, url: 'https://glean.com', note: 'Work assistant over internal data.' },
  { name: 'Harvey', category: 'Legal AI', channel: 'Web app', arr: '~$50M ARR', customers: 'Law firms, in-house', signal: 88, url: 'https://harvey.ai', note: 'Domain AI for legal workflows.' },
  { name: 'Clay', category: 'GTM data / enrichment', channel: 'Web app', arr: '~$30M ARR', customers: 'GTM / RevOps teams', signal: 87, url: 'https://clay.com', note: 'Programmatic prospecting + enrichment.' },
  { name: 'ElevenLabs', category: 'Voice AI', channel: 'API + web', arr: '~$100M ARR', customers: 'Devs + media', signal: 86, url: 'https://elevenlabs.io', note: 'Voice synthesis API, viral B2B+B2D.' },
  { name: 'Sierra', category: 'AI customer-experience agents', channel: 'API + web', arr: '~$20M ARR', customers: 'Enterprise support', signal: 85, url: 'https://sierra.ai', note: 'Conversational AI for support.' },
  { name: 'Cognition (Devin)', category: 'AI software engineer', channel: 'Web + IDE', arr: '~$70M ARR', customers: 'Eng teams', signal: 84, url: 'https://cognition.ai', note: 'Autonomous coding agent.' },
  { name: 'Perplexity Enterprise', category: 'AI answers for teams', channel: 'Web app', arr: 'Fast-growing', customers: 'Knowledge workers', signal: 84, url: 'https://perplexity.ai/enterprise', note: 'Enterprise search/answers tier.' },
  { name: 'Mercor', category: 'AI hiring / data labeling', channel: 'Web app', arr: '~$50M ARR', customers: 'AI labs, enterprises', signal: 83, url: 'https://mercor.com', note: 'Talent marketplace for AI training.' },
  { name: 'Decagon', category: 'AI support agents', channel: 'API + web', arr: '~$15M ARR', customers: 'Enterprise support', signal: 82, url: 'https://decagon.ai', note: 'Customer-service AI agents.' },
  { name: 'Replit', category: 'AI dev / agents', channel: 'Web IDE', arr: '~$100M ARR', customers: 'Devs, teams', signal: 81, url: 'https://replit.com', note: 'Agent-led app building in browser.' },
  { name: 'Listen Labs', category: 'AI consumer research', channel: 'Web app', arr: 'Early, fast', customers: 'Enterprise insights', signal: 80, url: 'https://listenlabs.ai', note: 'Team callout: AI interviews → enterprises.' },
  { name: '11x', category: 'AI SDRs / sales agents', channel: 'Web app', arr: '~$10M ARR', customers: 'GTM teams', signal: 78, url: 'https://11x.ai', note: 'Digital sales-rep agents.' },
  { name: 'Hebbia', category: 'AI knowledge (finance)', channel: 'Web app', arr: '~$13M ARR', customers: 'Finance, legal', signal: 76, url: 'https://hebbia.ai', note: 'Document AI for high-stakes work.' },
];

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess || sess.role !== 'admin' || !isAdminName(sess.name)) return json(res, 403, { error: 'admins only' });
  const companies = [...SEED].sort((a, b) => b.signal - a.signal);
  return json(res, 200, { companies, count: companies.length, source: 'seed' });
}
