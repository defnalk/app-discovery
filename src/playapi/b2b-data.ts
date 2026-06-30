/** B2B company dataset for the admin B2B tracker (served by ./b2b.ts).
 *
 *  Hand-curated list of fast-growing B2B software companies (sold to companies,
 *  mostly NOT on app stores: web / Slack / API / IDE). This is the data layer the
 *  live sourcing pipeline (TechCrunch / web scrapers + research prompts) will
 *  regenerate. Keeping it in its own module means refreshing the list never
 *  touches the endpoint logic.
 *
 *  Figures are APPROXIMATE PUBLIC ESTIMATES (ARR, customers) as of early 2026, not
 *  audited. `signal` is a 0-100 traction-heat estimate used only for ranking. */

export type B2BCompany = {
  name: string;
  category: string;
  channel: string;   // how it's delivered/sold: Web, Slack, API, IDE, etc.
  arr: string;       // traction descriptor (approx)
  customers: string; // who buys / scale
  signal: number;    // 0-100 traction heat (ranking only)
  url: string;
  note: string;
};

export const B2B_COMPANIES: B2BCompany[] = [
  // ── AI dev tools / coding ───────────────────────────────────────────────
  { name: 'Cursor (Anysphere)', category: 'AI coding / IDE', channel: 'Desktop IDE', arr: '~$300M+ ARR', customers: 'Devs + eng teams', signal: 99, url: 'https://cursor.com', note: 'Fastest app to $100M+ ARR; default AI IDE.' },
  { name: 'Lovable', category: 'AI app builder', channel: 'Web app', arr: '~$80M ARR (~8mo)', customers: 'Builders, SMB', signal: 95, url: 'https://lovable.dev', note: 'Text-to-app; record early ARR ramp out of EU.' },
  { name: 'Replit', category: 'AI dev / agents', channel: 'Web IDE', arr: '~$100M+ ARR', customers: 'Devs, teams', signal: 88, url: 'https://replit.com', note: 'Agent-led app building in the browser.' },
  { name: 'Vercel (v0)', category: 'AI frontend / hosting', channel: 'Web + CLI', arr: '~$200M ARR', customers: 'Frontend teams', signal: 87, url: 'https://v0.dev', note: 'v0 generative UI on top of the Vercel platform.' },
  { name: 'Windsurf (Codeium)', category: 'AI coding / IDE', channel: 'Desktop IDE', arr: '~$80M ARR', customers: 'Devs, enterprise', signal: 86, url: 'https://windsurf.com', note: 'Agentic IDE; enterprise code assistant.' },
  { name: 'Cognition (Devin)', category: 'AI software engineer', channel: 'Web + IDE', arr: '~$70M ARR', customers: 'Eng teams', signal: 85, url: 'https://cognition.ai', note: 'Autonomous coding agent; acquired Windsurf team.' },
  { name: 'Bolt (StackBlitz)', category: 'AI app builder', channel: 'Web app', arr: '~$40M ARR (fast)', customers: 'Builders, SMB', signal: 83, url: 'https://bolt.new', note: 'In-browser full-stack app generation.' },
  { name: 'Poolside', category: 'AI coding foundation models', channel: 'API + enterprise', arr: 'Pre-rev / enterprise', customers: 'Enterprise eng', signal: 74, url: 'https://poolside.ai', note: 'Frontier code models for enterprise.' },

  // ── AI agents / coworkers ───────────────────────────────────────────────
  { name: 'Sierra', category: 'AI customer-experience agents', channel: 'API + web', arr: '~$20M ARR', customers: 'Enterprise support', signal: 86, url: 'https://sierra.ai', note: 'Bret Taylor; conversational AI for support.' },
  { name: 'Decagon', category: 'AI support agents', channel: 'API + web', arr: '~$15M ARR', customers: 'Enterprise support', signal: 84, url: 'https://decagon.ai', note: 'Customer-service AI agents at scale.' },
  { name: 'Victor.ai', category: 'AI coworker / agents', channel: 'Slack', arr: '~$20M ARR (~4mo)', customers: '~2,000 customers', signal: 91, url: 'https://victor.ai', note: 'Team callout: ~$20M ARR in 4 months.' },
  { name: '11x', category: 'AI SDRs / sales agents', channel: 'Web app', arr: '~$10M ARR', customers: 'GTM teams', signal: 79, url: 'https://11x.ai', note: 'Digital sales-rep agents (Alice/Jordan).' },
  { name: 'Artisan', category: 'AI sales reps', channel: 'Web app', arr: '~$10M ARR', customers: 'SMB / mid-market sales', signal: 76, url: 'https://artisan.co', note: '"Ava" AI BDR; viral outbound campaigns.' },
  { name: 'Lindy', category: 'AI workflow agents', channel: 'Web app', arr: 'Fast-growing', customers: 'Ops teams, SMB', signal: 75, url: 'https://lindy.ai', note: 'No-code AI assistants for workflows.' },
  { name: 'Relevance AI', category: 'AI agent teams', channel: 'Web + API', arr: 'Fast-growing', customers: 'GTM / ops', signal: 73, url: 'https://relevanceai.com', note: 'Build and manage teams of AI agents.' },

  // ── Vertical AI ─────────────────────────────────────────────────────────
  { name: 'Harvey', category: 'Legal AI', channel: 'Web app', arr: '~$75M ARR', customers: 'Law firms, in-house', signal: 89, url: 'https://harvey.ai', note: 'Domain AI for legal workflows; fast enterprise ramp.' },
  { name: 'Abridge', category: 'Healthcare AI (clinical notes)', channel: 'Web + EHR', arr: '~$50M ARR', customers: 'Health systems', signal: 85, url: 'https://abridge.com', note: 'Ambient clinical documentation.' },
  { name: 'OpenEvidence', category: 'Medical AI', channel: 'Web app', arr: 'Fast-growing', customers: 'Clinicians', signal: 83, url: 'https://openevidence.com', note: '"ChatGPT for doctors"; explosive clinician adoption.' },
  { name: 'Ambience Healthcare', category: 'Healthcare AI', channel: 'Web + EHR', arr: 'Fast-growing', customers: 'Health systems', signal: 79, url: 'https://ambiencehealthcare.com', note: 'AI operating system for clinicians.' },
  { name: 'EvenUp', category: 'Legal AI (injury)', channel: 'Web app', arr: '~$40M ARR', customers: 'Personal-injury firms', signal: 80, url: 'https://evenuplaw.com', note: 'AI for injury-claim demand packages.' },
  { name: 'Hebbia', category: 'AI knowledge (finance)', channel: 'Web app', arr: '~$13M ARR', customers: 'Finance, legal', signal: 77, url: 'https://hebbia.ai', note: 'Document AI for high-stakes work.' },
  { name: 'Tennr', category: 'Healthcare ops AI', channel: 'Web + fax/API', arr: 'Fast-growing', customers: 'Healthcare providers', signal: 74, url: 'https://tennr.com', note: 'AI for patient referrals/intake.' },

  // ── GTM / sales / data ──────────────────────────────────────────────────
  { name: 'Clay', category: 'GTM data / enrichment', channel: 'Web app', arr: '~$30M ARR', customers: 'GTM / RevOps teams', signal: 87, url: 'https://clay.com', note: 'Programmatic prospecting + enrichment; viral with GTM.' },
  { name: 'Common Room', category: 'Signal-based GTM', channel: 'Web app', arr: 'Fast-growing', customers: 'GTM teams', signal: 72, url: 'https://commonroom.io', note: 'Unifies buying signals across channels.' },
  { name: 'Unify', category: 'AI go-to-market', channel: 'Web app', arr: 'Fast-growing', customers: 'GTM teams', signal: 71, url: 'https://unifygtm.com', note: 'Warm-outbound on intent signals + agents.' },

  // ── Enterprise search / knowledge ───────────────────────────────────────
  { name: 'Glean', category: 'Enterprise AI search', channel: 'Web + connectors', arr: '~$100M ARR', customers: 'Enterprise', signal: 90, url: 'https://glean.com', note: 'Work assistant over internal company data.' },
  { name: 'Dust', category: 'Enterprise AI agents', channel: 'Web + API', arr: 'Fast-growing', customers: 'Enterprise teams', signal: 73, url: 'https://dust.tt', note: 'Custom AI assistants over company data (EU).' },
  { name: 'Perplexity Enterprise', category: 'AI answers for teams', channel: 'Web app', arr: 'Fast-growing', customers: 'Knowledge workers', signal: 84, url: 'https://perplexity.ai/enterprise', note: 'Enterprise search/answers tier.' },

  // ── Voice / communication AI ────────────────────────────────────────────
  { name: 'ElevenLabs', category: 'Voice AI', channel: 'API + web', arr: '~$100M ARR', customers: 'Devs + media', signal: 88, url: 'https://elevenlabs.io', note: 'Voice synthesis API; viral B2B + B2D.' },
  { name: 'Cartesia', category: 'Real-time voice AI', channel: 'API', arr: 'Early, fast', customers: 'Devs, voice apps', signal: 74, url: 'https://cartesia.ai', note: 'Low-latency voice models (Sonic).' },
  { name: 'Vapi', category: 'Voice agent infra', channel: 'API', arr: 'Fast-growing', customers: 'Devs', signal: 75, url: 'https://vapi.ai', note: 'Developer platform for voice agents.' },
  { name: 'Retell AI', category: 'Voice agent infra', channel: 'API', arr: 'Fast-growing', customers: 'Devs, call centers', signal: 72, url: 'https://retellai.com', note: 'Build phone-call AI agents.' },

  // ── Data / AI infra ─────────────────────────────────────────────────────
  { name: 'Together AI', category: 'AI inference / training', channel: 'API', arr: '~$130M ARR', customers: 'AI builders', signal: 83, url: 'https://together.ai', note: 'Open-model inference + GPU cloud.' },
  { name: 'Fireworks AI', category: 'AI inference', channel: 'API', arr: '~$140M ARR', customers: 'AI builders', signal: 82, url: 'https://fireworks.ai', note: 'Fast, cheap open-model inference.' },
  { name: 'Baseten', category: 'AI model deployment', channel: 'API', arr: 'Fast-growing', customers: 'AI/ML teams', signal: 76, url: 'https://baseten.co', note: 'Serve and scale ML models in production.' },
  { name: 'Modal', category: 'Serverless AI compute', channel: 'API / SDK', arr: 'Fast-growing', customers: 'AI/ML teams', signal: 75, url: 'https://modal.com', note: 'Serverless GPU compute for AI.' },
  { name: 'Pinecone', category: 'Vector database', channel: 'API', arr: '~$50M ARR', customers: 'AI builders', signal: 73, url: 'https://pinecone.io', note: 'Managed vector DB for RAG.' },

  // ── Security ────────────────────────────────────────────────────────────
  { name: 'Wiz', category: 'Cloud security', channel: 'Web platform', arr: '~$1B ARR', customers: 'Enterprise', signal: 92, url: 'https://wiz.io', note: 'Fastest-ever to $100M then $1B ARR; ~$32B Google deal.' },
  { name: 'Cyera', category: 'Data security (DSPM)', channel: 'Web platform', arr: '~$100M ARR', customers: 'Enterprise', signal: 81, url: 'https://cyera.com', note: 'AI-era data security posture management.' },
  { name: 'Chainguard', category: 'Software supply-chain security', channel: 'Platform', arr: '~$40M ARR', customers: 'Enterprise eng', signal: 78, url: 'https://chainguard.dev', note: 'Secure container images; fast enterprise growth.' },
  { name: 'Semgrep', category: 'AppSec / code scanning', channel: 'CLI + platform', arr: 'Fast-growing', customers: 'Eng / security teams', signal: 71, url: 'https://semgrep.dev', note: 'Developer-first static analysis.' },

  // ── Hiring / talent ─────────────────────────────────────────────────────
  { name: 'Mercor', category: 'AI hiring / data labeling', channel: 'Web app', arr: '~$100M ARR', customers: 'AI labs, enterprises', signal: 85, url: 'https://mercor.com', note: 'Talent marketplace powering AI training data.' },
  { name: 'Micro1', category: 'AI recruiting', channel: 'Web app', arr: 'Fast-growing', customers: 'Eng teams', signal: 72, url: 'https://micro1.ai', note: 'AI-vetted engineer hiring.' },

  // ── Productivity / meetings (B2B) ───────────────────────────────────────
  { name: 'Granola', category: 'AI meeting notes', channel: 'Desktop app', arr: 'Fast-growing', customers: 'Teams, founders', signal: 80, url: 'https://granola.ai', note: 'Loved AI notepad; strong viral B2B adoption.' },
  { name: 'Read AI', category: 'AI meeting intelligence', channel: 'Web + integrations', arr: 'Fast-growing', customers: 'Teams', signal: 70, url: 'https://read.ai', note: 'Meeting summaries + analytics.' },
  { name: 'Gamma', category: 'AI presentations / sites', channel: 'Web app', arr: '~$50M ARR', customers: 'SMB, teams', signal: 79, url: 'https://gamma.app', note: 'AI decks/sites; profitable, lean team.' },

  // ── Research / insights (team callouts) ─────────────────────────────────
  { name: 'Listen Labs', category: 'AI consumer research', channel: 'Web app', arr: 'Early, fast', customers: 'Enterprise insights', signal: 81, url: 'https://listenlabs.ai', note: 'Team callout: AI interviews with consumers → enterprises.' },

  // ── Finance / ops AI ────────────────────────────────────────────────────
  { name: 'Ramp', category: 'Finance ops / spend', channel: 'Web platform', arr: '~$700M ARR', customers: 'SMB → enterprise', signal: 86, url: 'https://ramp.com', note: 'Fast-growing fintech; aggressive AI features.' },
  { name: 'Rogo', category: 'AI for finance/IB', channel: 'Web app', arr: 'Fast-growing', customers: 'Investment banks', signal: 73, url: 'https://rogo.ai', note: 'AI analyst for financial services.' },
  { name: 'Pylon', category: 'B2B support platform', channel: 'Web + Slack', arr: 'Fast-growing', customers: 'B2B SaaS', signal: 71, url: 'https://usepylon.com', note: 'Customer support built for B2B/Slack Connect.' },
];
