/** B2B company dataset for the admin B2B tracker (served by ./b2b.ts).
 *
 *  Hand-curated list of fast-growing B2B software companies (sold to companies,
 *  mostly NOT on app stores: web / Slack / API / IDE). This is the data layer the
 *  live sourcing pipeline (TechCrunch / web scrapers + research prompts) will
 *  regenerate. Keeping it in its own module means refreshing the list never
 *  touches the endpoint logic.
 *
 *  Figures are APPROXIMATE PUBLIC ESTIMATES (ARR, customers) as of early 2026, not
 *  audited. `signal` is a 0-100 traction-heat estimate used only for ranking.
 *
 *  `build` = how long for 8x to ship a credible MVP of the CORE WEDGE (not a full
 *  clone of the company). This is what makes an entry a "play". Scale:
 *    'weekend' (≤2d) · 'few_days' (3-5d) · 'week' (~1wk) · 'weeks' (2-4wk) · 'complex' (1mo+)
 *  The dashboard treats weekend/few_days/week as "buildable in a week max". */

export type Buildability = 'weekend' | 'few_days' | 'week' | 'weeks' | 'complex';

export type B2BCompany = {
  name: string;
  category: string;
  channel: string;   // how it's delivered/sold: Web, Slack, API, IDE, etc.
  arr: string;       // traction descriptor (approx)
  customers: string; // who buys / scale
  signal: number;    // 0-100 traction heat (ranking only)
  build: Buildability; // time to a credible MVP of the core wedge
  url: string;
  note: string;
};

export const B2B_COMPANIES: B2BCompany[] = [
  // ── AI dev tools / coding ───────────────────────────────────────────────
  { name: 'Cursor (Anysphere)', category: 'AI coding / IDE', channel: 'Desktop IDE', arr: '~$300M+ ARR', customers: 'Devs + eng teams', signal: 99, build: 'complex', url: 'https://cursor.com', note: 'Full AI IDE; deep editor + model work. MVP wedge still months.' },
  { name: 'Lovable', category: 'AI app builder', channel: 'Web app', arr: '~$80M ARR (~8mo)', customers: 'Builders, SMB', signal: 95, build: 'weeks', url: 'https://lovable.dev', note: 'Text-to-app; a narrow-vertical generator MVP is a few weeks.' },
  { name: 'Replit', category: 'AI dev / agents', channel: 'Web IDE', arr: '~$100M+ ARR', customers: 'Devs, teams', signal: 88, build: 'complex', url: 'https://replit.com', note: 'Browser IDE + agent + infra; not a week MVP.' },
  { name: 'Vercel (v0)', category: 'AI frontend / hosting', channel: 'Web + CLI', arr: '~$200M ARR', customers: 'Frontend teams', signal: 87, build: 'weeks', url: 'https://v0.dev', note: 'A v0-style UI generator wedge is a few weeks.' },
  { name: 'Windsurf (Codeium)', category: 'AI coding / IDE', channel: 'Desktop IDE', arr: '~$80M ARR', customers: 'Devs, enterprise', signal: 86, build: 'complex', url: 'https://windsurf.com', note: 'Agentic IDE; deep tooling.' },
  { name: 'Cognition (Devin)', category: 'AI software engineer', channel: 'Web + IDE', arr: '~$70M ARR', customers: 'Eng teams', signal: 85, build: 'complex', url: 'https://cognition.ai', note: 'Autonomous coding agent; hard to MVP credibly.' },
  { name: 'Bolt (StackBlitz)', category: 'AI app builder', channel: 'Web app', arr: '~$40M ARR (fast)', customers: 'Builders, SMB', signal: 83, build: 'weeks', url: 'https://bolt.new', note: 'In-browser app gen; WebContainer tech is the hard part.' },
  { name: 'Poolside', category: 'AI coding foundation models', channel: 'API + enterprise', arr: 'Pre-rev / enterprise', customers: 'Enterprise eng', signal: 74, build: 'complex', url: 'https://poolside.ai', note: 'Frontier code models; not replicable.' },

  // ── AI agents / coworkers ───────────────────────────────────────────────
  { name: 'Sierra', category: 'AI customer-experience agents', channel: 'API + web', arr: '~$20M ARR', customers: 'Enterprise support', signal: 86, build: 'weeks', url: 'https://sierra.ai', note: 'Enterprise support agent; a scoped vertical agent is weeks.' },
  { name: 'Decagon', category: 'AI support agents', channel: 'API + web', arr: '~$15M ARR', customers: 'Enterprise support', signal: 84, build: 'week', url: 'https://decagon.ai', note: 'A support-chatbot MVP over a help center is ~a week.' },
  { name: 'Victor.ai', category: 'AI coworker / agents', channel: 'Slack', arr: '~$20M ARR (~4mo)', customers: '~2,000 customers', signal: 91, build: 'week', url: 'https://victor.ai', note: 'Team callout. A Slack AI-coworker MVP is ~a week.' },
  { name: '11x', category: 'AI SDRs / sales agents', channel: 'Web app', arr: '~$10M ARR', customers: 'GTM teams', signal: 79, build: 'few_days', url: 'https://11x.ai', note: 'AI SDR; a scoped outbound agent over existing tools is days.' },
  { name: 'Artisan', category: 'AI sales reps', channel: 'Web app', arr: '~$10M ARR', customers: 'SMB / mid-market sales', signal: 76, build: 'few_days', url: 'https://artisan.co', note: '"Ava" BDR; an MVP outbound agent is a few days.' },
  { name: 'Lindy', category: 'AI workflow agents', channel: 'Web app', arr: 'Fast-growing', customers: 'Ops teams, SMB', signal: 75, build: 'week', url: 'https://lindy.ai', note: 'No-code agents; a templated-workflow MVP is ~a week.' },
  { name: 'Relevance AI', category: 'AI agent teams', channel: 'Web + API', arr: 'Fast-growing', customers: 'GTM / ops', signal: 73, build: 'week', url: 'https://relevanceai.com', note: 'Agent builder; a single-use-case version is ~a week.' },

  // ── Vertical AI ─────────────────────────────────────────────────────────
  { name: 'Harvey', category: 'Legal AI', channel: 'Web app', arr: '~$75M ARR', customers: 'Law firms, in-house', signal: 89, build: 'weeks', url: 'https://harvey.ai', note: 'Deep legal + security/integrations; a narrow legal-task MVP is weeks.' },
  { name: 'Abridge', category: 'Healthcare AI (clinical notes)', channel: 'Web + EHR', arr: '~$50M ARR', customers: 'Health systems', signal: 85, build: 'complex', url: 'https://abridge.com', note: 'EHR integration + compliance; not a week MVP.' },
  { name: 'OpenEvidence', category: 'Medical AI', channel: 'Web app', arr: 'Fast-growing', customers: 'Clinicians', signal: 83, build: 'weeks', url: 'https://openevidence.com', note: 'A grounded medical-Q&A MVP over a corpus is a few weeks.' },
  { name: 'Ambience Healthcare', category: 'Healthcare AI', channel: 'Web + EHR', arr: 'Fast-growing', customers: 'Health systems', signal: 79, build: 'complex', url: 'https://ambiencehealthcare.com', note: 'Clinical OS + EHR; complex.' },
  { name: 'EvenUp', category: 'Legal AI (injury)', channel: 'Web app', arr: '~$40M ARR', customers: 'Personal-injury firms', signal: 80, build: 'weeks', url: 'https://evenuplaw.com', note: 'Demand-package generator; a doc-pipeline MVP is weeks.' },
  { name: 'Hebbia', category: 'AI knowledge (finance)', channel: 'Web app', arr: '~$13M ARR', customers: 'Finance, legal', signal: 77, build: 'weeks', url: 'https://hebbia.ai', note: 'Document AI; a scoped RAG-over-docs MVP is weeks.' },
  { name: 'Tennr', category: 'Healthcare ops AI', channel: 'Web + fax/API', arr: 'Fast-growing', customers: 'Healthcare providers', signal: 74, build: 'weeks', url: 'https://tennr.com', note: 'Referral/intake automation; integration-heavy.' },

  // ── GTM / sales / data ──────────────────────────────────────────────────
  { name: 'Clay', category: 'GTM data / enrichment', channel: 'Web app', arr: '~$30M ARR', customers: 'GTM / RevOps teams', signal: 87, build: 'weeks', url: 'https://clay.com', note: 'Many data integrations are the moat; a lite enrichment table is weeks.' },
  { name: 'Common Room', category: 'Signal-based GTM', channel: 'Web app', arr: 'Fast-growing', customers: 'GTM teams', signal: 72, build: 'weeks', url: 'https://commonroom.io', note: 'Signal aggregation across sources; integration-heavy.' },
  { name: 'Unify', category: 'AI go-to-market', channel: 'Web app', arr: 'Fast-growing', customers: 'GTM teams', signal: 71, build: 'week', url: 'https://unifygtm.com', note: 'Intent-triggered outbound; a scoped MVP is ~a week.' },

  // ── Enterprise search / knowledge ───────────────────────────────────────
  { name: 'Glean', category: 'Enterprise AI search', channel: 'Web + connectors', arr: '~$100M ARR', customers: 'Enterprise', signal: 90, build: 'complex', url: 'https://glean.com', note: 'Dozens of secure connectors + permissions; complex.' },
  { name: 'Dust', category: 'Enterprise AI agents', channel: 'Web + API', arr: 'Fast-growing', customers: 'Enterprise teams', signal: 73, build: 'weeks', url: 'https://dust.tt', note: 'Assistants over company data; a few-connector MVP is weeks.' },
  { name: 'Perplexity Enterprise', category: 'AI answers for teams', channel: 'Web app', arr: 'Fast-growing', customers: 'Knowledge workers', signal: 84, build: 'weeks', url: 'https://perplexity.ai/enterprise', note: 'Answer engine + internal sources; a scoped MVP is weeks.' },

  // ── Voice / communication AI ────────────────────────────────────────────
  { name: 'ElevenLabs', category: 'Voice AI', channel: 'API + web', arr: '~$100M ARR', customers: 'Devs + media', signal: 88, build: 'complex', url: 'https://elevenlabs.io', note: 'Frontier voice models; not replicable.' },
  { name: 'Cartesia', category: 'Real-time voice AI', channel: 'API', arr: 'Early, fast', customers: 'Devs, voice apps', signal: 74, build: 'complex', url: 'https://cartesia.ai', note: 'Low-latency voice models; research-grade.' },
  { name: 'Vapi', category: 'Voice agent infra', channel: 'API', arr: 'Fast-growing', customers: 'Devs', signal: 75, build: 'week', url: 'https://vapi.ai', note: 'Orchestration over STT/LLM/TTS; a single-use-case agent is ~a week.' },
  { name: 'Retell AI', category: 'Voice agent infra', channel: 'API', arr: 'Fast-growing', customers: 'Devs, call centers', signal: 72, build: 'week', url: 'https://retellai.com', note: 'Phone-call agents; a vertical caller MVP is ~a week.' },

  // ── Data / AI infra ─────────────────────────────────────────────────────
  { name: 'Together AI', category: 'AI inference / training', channel: 'API', arr: '~$130M ARR', customers: 'AI builders', signal: 83, build: 'complex', url: 'https://together.ai', note: 'GPU cloud + inference; capital + infra heavy.' },
  { name: 'Fireworks AI', category: 'AI inference', channel: 'API', arr: '~$140M ARR', customers: 'AI builders', signal: 82, build: 'complex', url: 'https://fireworks.ai', note: 'Inference infra; not replicable cheaply.' },
  { name: 'Baseten', category: 'AI model deployment', channel: 'API', arr: 'Fast-growing', customers: 'AI/ML teams', signal: 76, build: 'complex', url: 'https://baseten.co', note: 'Model serving infra; complex.' },
  { name: 'Modal', category: 'Serverless AI compute', channel: 'API / SDK', arr: 'Fast-growing', customers: 'AI/ML teams', signal: 75, build: 'complex', url: 'https://modal.com', note: 'Serverless GPU runtime; deep infra.' },
  { name: 'Pinecone', category: 'Vector database', channel: 'API', arr: '~$50M ARR', customers: 'AI builders', signal: 73, build: 'complex', url: 'https://pinecone.io', note: 'Managed vector DB; infra-heavy.' },

  // ── Security ────────────────────────────────────────────────────────────
  { name: 'Wiz', category: 'Cloud security', channel: 'Web platform', arr: '~$1B ARR', customers: 'Enterprise', signal: 92, build: 'complex', url: 'https://wiz.io', note: 'Deep cloud-scanning platform; not replicable.' },
  { name: 'Cyera', category: 'Data security (DSPM)', channel: 'Web platform', arr: '~$100M ARR', customers: 'Enterprise', signal: 81, build: 'complex', url: 'https://cyera.com', note: 'Data classification at scale; complex.' },
  { name: 'Chainguard', category: 'Software supply-chain security', channel: 'Platform', arr: '~$40M ARR', customers: 'Enterprise eng', signal: 78, build: 'complex', url: 'https://chainguard.dev', note: 'Hardened image pipeline; deep ops.' },
  { name: 'Semgrep', category: 'AppSec / code scanning', channel: 'CLI + platform', arr: 'Fast-growing', customers: 'Eng / security teams', signal: 71, build: 'complex', url: 'https://semgrep.dev', note: 'Static-analysis engine + rules; complex.' },

  // ── Hiring / talent ─────────────────────────────────────────────────────
  { name: 'Mercor', category: 'AI hiring / data labeling', channel: 'Web app', arr: '~$100M ARR', customers: 'AI labs, enterprises', signal: 85, build: 'weeks', url: 'https://mercor.com', note: 'Two-sided talent marketplace; supply is the hard part.' },
  { name: 'Micro1', category: 'AI recruiting', channel: 'Web app', arr: 'Fast-growing', customers: 'Eng teams', signal: 72, build: 'week', url: 'https://micro1.ai', note: 'AI interview screener; a single-flow MVP is ~a week.' },

  // ── Productivity / meetings (B2B) ───────────────────────────────────────
  { name: 'Granola', category: 'AI meeting notes', channel: 'Desktop app', arr: 'Fast-growing', customers: 'Teams, founders', signal: 80, build: 'week', url: 'https://granola.ai', note: 'AI notepad; a capture+summary MVP is ~a week (polish is the moat).' },
  { name: 'Read AI', category: 'AI meeting intelligence', channel: 'Web + integrations', arr: 'Fast-growing', customers: 'Teams', signal: 70, build: 'week', url: 'https://read.ai', note: 'Meeting summaries; a bot-join + summary MVP is ~a week.' },
  { name: 'Gamma', category: 'AI presentations / sites', channel: 'Web app', arr: '~$50M ARR', customers: 'SMB, teams', signal: 79, build: 'weeks', url: 'https://gamma.app', note: 'AI decks/sites; the editor is the work, MVP is weeks.' },

  // ── Research / insights (team callouts) ─────────────────────────────────
  { name: 'Listen Labs', category: 'AI consumer research', channel: 'Web app', arr: 'Early, fast', customers: 'Enterprise insights', signal: 81, build: 'week', url: 'https://listenlabs.ai', note: 'Team callout. An AI-interview + synthesis MVP is ~a week.' },

  // ── Finance / ops AI ────────────────────────────────────────────────────
  { name: 'Ramp', category: 'Finance ops / spend', channel: 'Web platform', arr: '~$700M ARR', customers: 'SMB → enterprise', signal: 86, build: 'complex', url: 'https://ramp.com', note: 'Cards + banking + compliance; not replicable.' },
  { name: 'Rogo', category: 'AI for finance/IB', channel: 'Web app', arr: 'Fast-growing', customers: 'Investment banks', signal: 73, build: 'weeks', url: 'https://rogo.ai', note: 'Analyst over financial data; data access is the hard part.' },
  { name: 'Pylon', category: 'B2B support platform', channel: 'Web + Slack', arr: 'Fast-growing', customers: 'B2B SaaS', signal: 71, build: 'week', url: 'https://usepylon.com', note: 'Slack-Connect support inbox; a routing+ticket MVP is ~a week.' },
];
