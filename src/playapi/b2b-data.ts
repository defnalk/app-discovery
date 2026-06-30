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
 *  The dashboard treats weekend/few_days/week as "buildable in a week max".
 *
 *  `features` / `wedge` / `competitors` power the click-to-open detail panel:
 *  what the product does, the week-1 MVP scope, and who else plays here. */

export type Buildability = 'weekend' | 'few_days' | 'week' | 'weeks' | 'complex';

export type B2BCompany = {
  name: string;
  category: string;
  channel: string;       // how it's delivered/sold: Web, Slack, API, IDE, etc.
  arr: string;           // traction descriptor (approx)
  customers: string;     // who buys / scale
  signal: number;        // 0-100 traction heat (ranking only)
  build: Buildability;   // time to a credible MVP of the core wedge
  url: string;
  note: string;
  features: string[];    // notable product capabilities
  wedge: string;         // the week-1 MVP build plan / why it's (not) a week
  competitors: string[]; // main competitors in the space
};

export const B2B_COMPANIES: B2BCompany[] = [
  // ── AI dev tools / coding ───────────────────────────────────────────────
  { name: 'Cursor (Anysphere)', category: 'AI coding / IDE', channel: 'Desktop IDE', arr: '~$300M+ ARR', customers: 'Devs + eng teams', signal: 99, build: 'complex', url: 'https://cursor.com', note: 'Full AI IDE; deep editor + model work.',
    features: ['Tab autocomplete', 'Agent mode (multi-file edits)', 'Codebase chat/RAG', 'Inline edit (⌘K)'], wedge: 'Not a week play: forking VS Code + a tuned model + codebase indexing is months. A single-language autocomplete extension is a weekend but undifferentiated.', competitors: ['GitHub Copilot', 'Windsurf', 'Zed', 'JetBrains AI'] },
  { name: 'Lovable', category: 'AI app builder', channel: 'Web app', arr: '~$80M ARR (~8mo)', customers: 'Builders, SMB', signal: 95, build: 'weeks', url: 'https://lovable.dev', note: 'Text-to-app; record early ARR ramp out of EU.',
    features: ['Prompt-to-fullstack app', 'Live preview', 'Supabase/GitHub sync', 'One-click deploy'], wedge: 'Wedge: a niche-vertical generator (e.g. "prompt → CRM") on top of a fixed template + LLM codegen is a few weeks; the general builder is the hard part.', competitors: ['Bolt', 'v0', 'Replit', 'Base44'] },
  { name: 'Replit', category: 'AI dev / agents', channel: 'Web IDE', arr: '~$100M+ ARR', customers: 'Devs, teams', signal: 88, build: 'complex', url: 'https://replit.com', note: 'Browser IDE + agent + infra.',
    features: ['Cloud IDE', 'Agent build/deploy', 'Hosting + DB', 'Collaboration'], wedge: 'Complex: in-browser runtime + hosting + agent is deep infra, not a week.', competitors: ['Lovable', 'Bolt', 'GitHub Codespaces', 'v0'] },
  { name: 'Vercel (v0)', category: 'AI frontend / hosting', channel: 'Web + CLI', arr: '~$200M ARR', customers: 'Frontend teams', signal: 87, build: 'weeks', url: 'https://v0.dev', note: 'v0 generative UI on the Vercel platform.',
    features: ['Prompt-to-UI (React/Tailwind)', 'Component iteration', 'Codegen export', 'Deploy to Vercel'], wedge: 'Wedge: a prompt→React-component generator with live preview is a few weeks; the design quality + framework breadth is the moat.', competitors: ['Lovable', 'Bolt', 'Builder.io', 'Subframe'] },
  { name: 'Windsurf (Codeium)', category: 'AI coding / IDE', channel: 'Desktop IDE', arr: '~$80M ARR', customers: 'Devs, enterprise', signal: 86, build: 'complex', url: 'https://windsurf.com', note: 'Agentic IDE; enterprise code assistant.',
    features: ['Cascade agent', 'Codebase awareness', 'Enterprise self-host', 'Autocomplete'], wedge: 'Complex: same as Cursor — IDE + agent + enterprise security is months.', competitors: ['Cursor', 'GitHub Copilot', 'Cline', 'Augment'] },
  { name: 'Cognition (Devin)', category: 'AI software engineer', channel: 'Web + IDE', arr: '~$70M ARR', customers: 'Eng teams', signal: 85, build: 'complex', url: 'https://cognition.ai', note: 'Autonomous coding agent.',
    features: ['Autonomous task completion', 'Sandboxed env', 'PR creation', 'Slack/Linear triggers'], wedge: 'Complex: reliable autonomous SWE agent + sandbox infra is hard to MVP credibly.', competitors: ['Cursor agents', 'Factory', 'OpenHands', 'Codegen'] },
  { name: 'Bolt (StackBlitz)', category: 'AI app builder', channel: 'Web app', arr: '~$40M ARR (fast)', customers: 'Builders, SMB', signal: 83, build: 'weeks', url: 'https://bolt.new', note: 'In-browser full-stack app generation.',
    features: ['Prompt-to-app in browser', 'WebContainers runtime', 'Live edit', 'Deploy/export'], wedge: 'Wedge: the WebContainer in-browser runtime is the hard part; a server-side-codegen clone is a few weeks.', competitors: ['Lovable', 'v0', 'Replit', 'Create'] },
  { name: 'Poolside', category: 'AI coding foundation models', channel: 'API + enterprise', arr: 'Pre-rev / enterprise', customers: 'Enterprise eng', signal: 74, build: 'complex', url: 'https://poolside.ai', note: 'Frontier code models for enterprise.',
    features: ['Custom code models', 'On-prem deployment', 'RLHF on code execution', 'Enterprise fine-tune'], wedge: 'Not replicable: training frontier code models is a capital + research play, not a build.', competitors: ['Magic.dev', 'Cursor (Composer)', 'Codeium', 'Augment'] },

  // ── AI agents / coworkers ───────────────────────────────────────────────
  { name: 'Sierra', category: 'AI customer-experience agents', channel: 'API + web', arr: '~$20M ARR', customers: 'Enterprise support', signal: 86, build: 'weeks', url: 'https://sierra.ai', note: 'Bret Taylor; conversational AI for support.',
    features: ['Branded CX agent', 'Action-taking (refunds, orders)', 'Guardrails', 'Analytics'], wedge: 'Wedge: a scoped support agent over one help-center + 2-3 actions is a couple weeks; enterprise guardrails/integrations extend it.', competitors: ['Decagon', 'Intercom Fin', 'Ada', 'Forethought'] },
  { name: 'Decagon', category: 'AI support agents', channel: 'API + web', arr: '~$15M ARR', customers: 'Enterprise support', signal: 84, build: 'week', url: 'https://decagon.ai', note: 'Customer-service AI agents at scale.',
    features: ['AI support agent', 'Knowledge ingestion', 'Routing/escalation', 'QA dashboards'], wedge: 'Week-1: ingest a help center → RAG chatbot widget with handoff. Polish (analytics, actions) comes later.', competitors: ['Sierra', 'Ada', 'Intercom Fin', 'Maven AGI'] },
  { name: 'Victor.ai', category: 'AI coworker / agents', channel: 'Slack', arr: '~$20M ARR (~4mo)', customers: '~2,000 customers', signal: 91, build: 'week', url: 'https://victor.ai', note: 'Team callout: ~$20M ARR in 4 months.',
    features: ['Slack-native AI coworker', 'Task automation', 'Knowledge recall', 'Integrations'], wedge: 'Week-1: a Slack bot + LLM + a few tool integrations (calendar, docs). Distribution via Slack is the unlock.', competitors: ['Glean Assistant', 'Dust', 'Lindy', 'Cogna'] },
  { name: '11x', category: 'AI SDRs / sales agents', channel: 'Web app', arr: '~$10M ARR', customers: 'GTM teams', signal: 79, build: 'few_days', url: 'https://11x.ai', note: 'Digital sales-rep agents (Alice/Jordan).',
    features: ['AI SDR (Alice)', 'Lead research + personalization', 'Multichannel outreach', 'CRM sync'], wedge: 'Few days: chain enrichment (Clay/Apollo) + LLM personalization + an email sender. Pure orchestration over existing APIs.', competitors: ['Artisan', 'AiSDR', 'Clay', 'Qualified'] },
  { name: 'Artisan', category: 'AI sales reps', channel: 'Web app', arr: '~$10M ARR', customers: 'SMB / mid-market sales', signal: 76, build: 'few_days', url: 'https://artisan.co', note: '"Ava" AI BDR; viral outbound campaigns.',
    features: ['AI BDR (Ava)', 'Lead sourcing', 'Email warmup + sending', 'Playbooks'], wedge: 'Few days: same shape as 11x — data + LLM personalization + sequencer. Brand/marketing is their real edge.', competitors: ['11x', 'AiSDR', 'Outreach', 'Instantly'] },
  { name: 'Lindy', category: 'AI workflow agents', channel: 'Web app', arr: 'Fast-growing', customers: 'Ops teams, SMB', signal: 75, build: 'week', url: 'https://lindy.ai', note: 'No-code AI assistants for workflows.',
    features: ['No-code agent builder', '3,000+ integrations', 'Triggers/automations', 'Agent memory'], wedge: 'Week-1: a templated workflow agent for ONE use case (e.g. meeting → CRM). The general builder + integration breadth is the moat.', competitors: ['Relevance AI', 'Zapier Agents', 'Gumloop', 'n8n'] },
  { name: 'Relevance AI', category: 'AI agent teams', channel: 'Web + API', arr: 'Fast-growing', customers: 'GTM / ops', signal: 73, build: 'week', url: 'https://relevanceai.com', note: 'Build and manage teams of AI agents.',
    features: ['Multi-agent "workforce"', 'Tool use', 'No-code + API', 'Templates'], wedge: 'Week-1: a single-purpose agent (e.g. inbound-lead qualifier) shipped as a widget/API.', competitors: ['Lindy', 'Gumloop', 'CrewAI', 'Vellum'] },

  // ── Vertical AI ─────────────────────────────────────────────────────────
  { name: 'Harvey', category: 'Legal AI', channel: 'Web app', arr: '~$75M ARR', customers: 'Law firms, in-house', signal: 89, build: 'weeks', url: 'https://harvey.ai', note: 'Domain AI for legal workflows; fast enterprise ramp.',
    features: ['Legal research + drafting', 'Document review', 'Workflow agents', 'Firm knowledge'], wedge: 'Wedge: a single legal task (e.g. contract-clause review) over uploaded docs is a couple weeks; trust + security for firms extend it.', competitors: ['Legora', 'Robin AI', 'Spellbook', 'CoCounsel'] },
  { name: 'Abridge', category: 'Healthcare AI (clinical notes)', channel: 'Web + EHR', arr: '~$50M ARR', customers: 'Health systems', signal: 85, build: 'complex', url: 'https://abridge.com', note: 'Ambient clinical documentation.',
    features: ['Ambient scribe', 'EHR (Epic) integration', 'Coding support', 'Specialty models'], wedge: 'Complex: EHR integration + HIPAA + clinical accuracy is a long enterprise build, not a week.', competitors: ['Nuance DAX', 'Ambience', 'Suki', 'Nabla'] },
  { name: 'OpenEvidence', category: 'Medical AI', channel: 'Web app', arr: 'Fast-growing', customers: 'Clinicians', signal: 83, build: 'weeks', url: 'https://openevidence.com', note: '"ChatGPT for doctors"; explosive clinician adoption.',
    features: ['Grounded medical Q&A', 'Cited from journals', 'Clinician verification', 'Free for HCPs'], wedge: 'Wedge: a RAG Q&A over a licensed medical corpus with citations is a few weeks; the content licensing + trust is the edge.', competitors: ['UpToDate', 'Glass Health', 'Consensus', 'Perplexity'] },
  { name: 'Ambience Healthcare', category: 'Healthcare AI', channel: 'Web + EHR', arr: 'Fast-growing', customers: 'Health systems', signal: 79, build: 'complex', url: 'https://ambiencehealthcare.com', note: 'AI operating system for clinicians.',
    features: ['Ambient documentation', 'Coding/CDI', 'Referral letters', 'EHR integration'], wedge: 'Complex: full clinical OS + EHR + compliance is enterprise-scale.', competitors: ['Abridge', 'Nuance DAX', 'Suki', 'Nabla'] },
  { name: 'EvenUp', category: 'Legal AI (injury)', channel: 'Web app', arr: '~$40M ARR', customers: 'Personal-injury firms', signal: 80, build: 'weeks', url: 'https://evenuplaw.com', note: 'AI for injury-claim demand packages.',
    features: ['Demand-letter generation', 'Medical-record analysis', 'Case valuation', 'Document pipeline'], wedge: 'Wedge: a medical-records → demand-letter pipeline for one claim type is a few weeks.', competitors: ['Supio', 'Eve', 'Parrot', 'Harvey'] },
  { name: 'Hebbia', category: 'AI knowledge (finance)', channel: 'Web app', arr: '~$13M ARR', customers: 'Finance, legal', signal: 77, build: 'weeks', url: 'https://hebbia.ai', note: 'Document AI for high-stakes work.',
    features: ['Matrix (doc-grid analysis)', 'Multi-doc reasoning', 'Citations', 'Enterprise security'], wedge: 'Wedge: a RAG-over-documents tool with a spreadsheet UI is a few weeks; scale + accuracy on huge doc sets is the moat.', competitors: ['Rogo', 'AlphaSense', 'V7 Go', 'Glean'] },
  { name: 'Tennr', category: 'Healthcare ops AI', channel: 'Web + fax/API', arr: 'Fast-growing', customers: 'Healthcare providers', signal: 74, build: 'weeks', url: 'https://tennr.com', note: 'AI for patient referrals/intake.',
    features: ['Fax/referral parsing', 'Patient intake automation', 'EHR write-back', 'Eligibility checks'], wedge: 'Wedge: a fax/PDF → structured-intake parser is a few weeks; healthcare integrations extend it.', competitors: ['Notable', 'Adonis', 'Infinitus', 'Commure'] },

  // ── GTM / sales / data ──────────────────────────────────────────────────
  { name: 'Clay', category: 'GTM data / enrichment', channel: 'Web app', arr: '~$30M ARR', customers: 'GTM / RevOps teams', signal: 87, build: 'weeks', url: 'https://clay.com', note: 'Programmatic prospecting + enrichment; viral with GTM.',
    features: ['100+ enrichment providers', 'Waterfall enrichment', 'AI research agent', 'CRM sync'], wedge: 'Wedge: a spreadsheet + a few enrichment APIs is a couple weeks; the 100-provider waterfall + credits engine is the moat.', competitors: ['Apollo', 'Ocean.io', 'Persana', 'Bardeen'] },
  { name: 'Common Room', category: 'Signal-based GTM', channel: 'Web app', arr: 'Fast-growing', customers: 'GTM teams', signal: 72, build: 'weeks', url: 'https://commonroom.io', note: 'Unifies buying signals across channels.',
    features: ['Signal aggregation', 'Person/account 360', 'Slack alerts', 'Automations'], wedge: 'Wedge: integration-heavy — pulling + unifying signals from many sources is the work.', competitors: ['Pocus', 'Default', 'Koala', 'HeadsUp'] },
  { name: 'Unify', category: 'AI go-to-market', channel: 'Web app', arr: 'Fast-growing', customers: 'GTM teams', signal: 71, build: 'week', url: 'https://unifygtm.com', note: 'Warm-outbound on intent signals + agents.',
    features: ['Intent/visitor signals', 'AI research agents', 'Auto-sequences', 'CRM sync'], wedge: 'Week-1: website-visitor identify + LLM personalization + a sequencer for one motion.', competitors: ['Clay', '11x', 'Common Room', 'Qualified'] },

  // ── Enterprise search / knowledge ───────────────────────────────────────
  { name: 'Glean', category: 'Enterprise AI search', channel: 'Web + connectors', arr: '~$100M ARR', customers: 'Enterprise', signal: 90, build: 'complex', url: 'https://glean.com', note: 'Work assistant over internal company data.',
    features: ['Unified work search', 'Permissions-aware', '100+ connectors', 'Assistant + agents'], wedge: 'Complex: secure permissions-aware connectors across dozens of SaaS tools is the whole moat — months.', competitors: ['Dust', 'Guru', 'Microsoft Copilot', 'Sana'] },
  { name: 'Dust', category: 'Enterprise AI agents', channel: 'Web + API', arr: 'Fast-growing', customers: 'Enterprise teams', signal: 73, build: 'weeks', url: 'https://dust.tt', note: 'Custom AI assistants over company data (EU).',
    features: ['Custom assistants', 'Connectors (Slack/Notion/GitHub)', 'Agent builder', 'Data permissions'], wedge: 'Wedge: assistants over 2-3 connectors is a few weeks; breadth + permissions extend it.', competitors: ['Glean', 'Sana', 'Cohere', 'Microsoft Copilot'] },
  { name: 'Perplexity Enterprise', category: 'AI answers for teams', channel: 'Web app', arr: 'Fast-growing', customers: 'Knowledge workers', signal: 84, build: 'weeks', url: 'https://perplexity.ai/enterprise', note: 'Enterprise search/answers tier.',
    features: ['Web + internal answers', 'Citations', 'Spaces/collections', 'SOC2/SSO'], wedge: 'Wedge: a cited web-answer engine is a few weeks; the index quality + brand is the moat.', competitors: ['Glean', 'ChatGPT Enterprise', 'Gemini', 'You.com'] },

  // ── Voice / communication AI ────────────────────────────────────────────
  { name: 'ElevenLabs', category: 'Voice AI', channel: 'API + web', arr: '~$100M ARR', customers: 'Devs + media', signal: 88, build: 'complex', url: 'https://elevenlabs.io', note: 'Voice synthesis API; viral B2B + B2D.',
    features: ['Text-to-speech', 'Voice cloning', 'Dubbing', 'Conversational/agents API'], wedge: 'Not replicable: frontier voice models. App-layer wrappers (dubbing tool) on top of their API are a weekend.', competitors: ['Cartesia', 'PlayHT', 'OpenAI TTS', 'Hume'] },
  { name: 'Cartesia', category: 'Real-time voice AI', channel: 'API', arr: 'Early, fast', customers: 'Devs, voice apps', signal: 74, build: 'complex', url: 'https://cartesia.ai', note: 'Low-latency voice models (Sonic).',
    features: ['Ultra-low-latency TTS', 'Voice cloning', 'On-device models', 'Streaming'], wedge: 'Not replicable: real-time voice model research (SSMs).', competitors: ['ElevenLabs', 'PlayHT', 'Rime', 'Deepgram'] },
  { name: 'Vapi', category: 'Voice agent infra', channel: 'API', arr: 'Fast-growing', customers: 'Devs', signal: 75, build: 'week', url: 'https://vapi.ai', note: 'Developer platform for voice agents.',
    features: ['Voice-agent orchestration', 'STT+LLM+TTS pipeline', 'Telephony', 'Function calling'], wedge: 'Week-1: wire Deepgram + an LLM + ElevenLabs + Twilio into one vertical phone agent (e.g. restaurant bookings).', competitors: ['Retell AI', 'Bland', 'Synthflow', 'Sindarin'] },
  { name: 'Retell AI', category: 'Voice agent infra', channel: 'API', arr: 'Fast-growing', customers: 'Devs, call centers', signal: 72, build: 'week', url: 'https://retellai.com', note: 'Build phone-call AI agents.',
    features: ['Phone-call agents', 'Low-latency pipeline', 'Call transfer', 'Analytics'], wedge: 'Week-1: same as Vapi — a vertical AI caller for one industry over the STT/LLM/TTS stack.', competitors: ['Vapi', 'Bland', 'Synthflow', 'Air.ai'] },

  // ── Data / AI infra ─────────────────────────────────────────────────────
  { name: 'Together AI', category: 'AI inference / training', channel: 'API', arr: '~$130M ARR', customers: 'AI builders', signal: 83, build: 'complex', url: 'https://together.ai', note: 'Open-model inference + GPU cloud.',
    features: ['Open-model inference', 'Fine-tuning', 'GPU clusters', 'Fast kernels'], wedge: 'Not replicable: GPU supply + inference optimization is a capital + systems play.', competitors: ['Fireworks', 'Baseten', 'Replicate', 'Anyscale'] },
  { name: 'Fireworks AI', category: 'AI inference', channel: 'API', arr: '~$140M ARR', customers: 'AI builders', signal: 82, build: 'complex', url: 'https://fireworks.ai', note: 'Fast, cheap open-model inference.',
    features: ['Fast inference', 'Fine-tuning', 'Compound AI', 'FireAttention kernels'], wedge: 'Not replicable: inference performance engineering at scale.', competitors: ['Together', 'Baseten', 'Groq', 'DeepInfra'] },
  { name: 'Baseten', category: 'AI model deployment', channel: 'API', arr: 'Fast-growing', customers: 'AI/ML teams', signal: 76, build: 'complex', url: 'https://baseten.co', note: 'Serve and scale ML models in production.',
    features: ['Model serving', 'Autoscaling GPUs', 'Truss packaging', 'Inference optimization'], wedge: 'Complex: production model-serving infra is deep systems work.', competitors: ['Modal', 'Replicate', 'Together', 'Beam'] },
  { name: 'Modal', category: 'Serverless AI compute', channel: 'API / SDK', arr: 'Fast-growing', customers: 'AI/ML teams', signal: 75, build: 'complex', url: 'https://modal.com', note: 'Serverless GPU compute for AI.',
    features: ['Serverless GPUs', 'Python-native', 'Fast cold starts', 'Batch/cron jobs'], wedge: 'Complex: a serverless GPU runtime with sub-second cold starts is deep infra.', competitors: ['Baseten', 'Replicate', 'RunPod', 'Beam'] },
  { name: 'Pinecone', category: 'Vector database', channel: 'API', arr: '~$50M ARR', customers: 'AI builders', signal: 73, build: 'complex', url: 'https://pinecone.io', note: 'Managed vector DB for RAG.',
    features: ['Managed vector index', 'Serverless tier', 'Hybrid search', 'Namespaces'], wedge: 'Complex: a performant managed vector DB is a hard infra build (pgvector wrappers are commoditized).', competitors: ['Weaviate', 'Qdrant', 'Turbopuffer', 'pgvector'] },

  // ── Security ────────────────────────────────────────────────────────────
  { name: 'Wiz', category: 'Cloud security', channel: 'Web platform', arr: '~$1B ARR', customers: 'Enterprise', signal: 92, build: 'complex', url: 'https://wiz.io', note: 'Fastest-ever to $100M then $1B ARR; ~$32B Google deal.',
    features: ['Agentless cloud scanning', 'Attack-path graph', 'CSPM/CNAPP', 'Risk prioritization'], wedge: 'Not replicable: agentless multi-cloud scanning + the security graph is years of platform work.', competitors: ['Orca', 'Palo Alto Prisma', 'CrowdStrike', 'Aqua'] },
  { name: 'Cyera', category: 'Data security (DSPM)', channel: 'Web platform', arr: '~$100M ARR', customers: 'Enterprise', signal: 81, build: 'complex', url: 'https://cyera.com', note: 'AI-era data security posture management.',
    features: ['Data discovery/classification', 'DSPM', 'DLP', 'Access governance'], wedge: 'Complex: classifying sensitive data across an enterprise estate at scale is hard.', competitors: ['BigID', 'Varonis', 'Sentra', 'Wiz DSPM'] },
  { name: 'Chainguard', category: 'Software supply-chain security', channel: 'Platform', arr: '~$40M ARR', customers: 'Enterprise eng', signal: 78, build: 'complex', url: 'https://chainguard.dev', note: 'Secure container images; fast enterprise growth.',
    features: ['Zero-CVE images', 'SBOMs/provenance', 'Hardened base images', 'Continuous rebuilds'], wedge: 'Complex: maintaining a continuously-rebuilt zero-CVE image catalog is an ops-heavy moat.', competitors: ['Docker', 'Red Hat', 'Snyk', 'Anchore'] },
  { name: 'Semgrep', category: 'AppSec / code scanning', channel: 'CLI + platform', arr: 'Fast-growing', customers: 'Eng / security teams', signal: 71, build: 'complex', url: 'https://semgrep.dev', note: 'Developer-first static analysis.',
    features: ['Static analysis (SAST)', 'Custom rules', 'Secrets scanning', 'Supply-chain (SCA)'], wedge: 'Complex: a multi-language static-analysis engine + rule ecosystem is deep.', competitors: ['Snyk', 'SonarQube', 'GitHub CodeQL', 'Endor Labs'] },

  // ── Hiring / talent ─────────────────────────────────────────────────────
  { name: 'Mercor', category: 'AI hiring / data labeling', channel: 'Web app', arr: '~$100M ARR', customers: 'AI labs, enterprises', signal: 85, build: 'weeks', url: 'https://mercor.com', note: 'Talent marketplace powering AI training data.',
    features: ['AI interview + vetting', 'Expert marketplace', 'Payments/compliance', 'Matching'], wedge: 'Wedge: the software (AI interviewer) is weeks; the vetted expert SUPPLY is the real moat.', competitors: ['Micro1', 'Scale AI', 'Turing', 'Surge AI'] },
  { name: 'Micro1', category: 'AI recruiting', channel: 'Web app', arr: 'Fast-growing', customers: 'Eng teams', signal: 72, build: 'week', url: 'https://micro1.ai', note: 'AI-vetted engineer hiring.',
    features: ['AI interviewer (Zara)', 'Technical assessment', 'Global talent pool', 'Async screening'], wedge: 'Week-1: an AI video-interviewer + scoring for one role type; the candidate pool is the harder side.', competitors: ['Mercor', 'HireVue', 'Karat', 'Turing'] },

  // ── Productivity / meetings (B2B) ───────────────────────────────────────
  { name: 'Granola', category: 'AI meeting notes', channel: 'Desktop app', arr: 'Fast-growing', customers: 'Teams, founders', signal: 80, build: 'week', url: 'https://granola.ai', note: 'Loved AI notepad; strong viral B2B adoption.',
    features: ['Local audio capture', 'Notes + AI enhance', 'No meeting bot', 'Templates/sharing'], wedge: 'Week-1: system-audio capture → transcription → LLM summary in a desktop app. The "no bot" UX + polish is the edge.', competitors: ['Otter', 'Fireflies', 'Fathom', 'Read AI'] },
  { name: 'Read AI', category: 'AI meeting intelligence', channel: 'Web + integrations', arr: 'Fast-growing', customers: 'Teams', signal: 70, build: 'week', url: 'https://read.ai', note: 'Meeting summaries + analytics.',
    features: ['Meeting summaries', 'Engagement analytics', 'Email/chat digests', 'Bot join'], wedge: 'Week-1: a meeting bot + transcript + LLM summary; analytics layer comes later.', competitors: ['Otter', 'Fireflies', 'Fathom', 'Granola'] },
  { name: 'Gamma', category: 'AI presentations / sites', channel: 'Web app', arr: '~$50M ARR', customers: 'SMB, teams', signal: 79, build: 'weeks', url: 'https://gamma.app', note: 'AI decks/sites; profitable, lean team.',
    features: ['Prompt-to-deck/site', 'Flexible card editor', 'Templates/themes', 'Analytics'], wedge: 'Wedge: prompt→slides codegen is days, but the flexible editor + design quality is what makes it sticky — weeks.', competitors: ['Tome', 'Beautiful.ai', 'Canva', 'Pitch'] },

  // ── Research / insights (team callouts) ─────────────────────────────────
  { name: 'Listen Labs', category: 'AI consumer research', channel: 'Web app', arr: 'Early, fast', customers: 'Enterprise insights', signal: 81, build: 'week', url: 'https://listenlabs.ai', note: 'Team callout: AI interviews with consumers → enterprises.',
    features: ['AI moderator interviews', 'Auto-recruiting', 'Theme synthesis', 'Video highlights'], wedge: 'Week-1: an AI chat/voice interviewer + LLM theme synthesis over responses; recruiting + scale is the extension.', competitors: ['Outset', 'Strella', 'User Interviews', 'Qualtrics'] },

  // ── Finance / ops AI ────────────────────────────────────────────────────
  { name: 'Ramp', category: 'Finance ops / spend', channel: 'Web platform', arr: '~$700M ARR', customers: 'SMB → enterprise', signal: 86, build: 'complex', url: 'https://ramp.com', note: 'Fast-growing fintech; aggressive AI features.',
    features: ['Corporate cards', 'Bill pay / AP', 'Expense automation', 'AI agents'], wedge: 'Not replicable: cards + banking partners + compliance is a regulated fintech build.', competitors: ['Brex', 'Mercury', 'Navan', 'Airbase'] },
  { name: 'Rogo', category: 'AI for finance/IB', channel: 'Web app', arr: 'Fast-growing', customers: 'Investment banks', signal: 73, build: 'weeks', url: 'https://rogo.ai', note: 'AI analyst for financial services.',
    features: ['Financial data Q&A', 'Model/memo drafting', 'Comps + screening', 'Secure data'], wedge: 'Wedge: a RAG analyst over licensed financial data is a few weeks; the data access + accuracy is the moat.', competitors: ['Hebbia', 'AlphaSense', 'BlueFlame', 'Perplexity'] },
  { name: 'Pylon', category: 'B2B support platform', channel: 'Web + Slack', arr: 'Fast-growing', customers: 'B2B SaaS', signal: 71, build: 'week', url: 'https://usepylon.com', note: 'Customer support built for B2B/Slack Connect.',
    features: ['Slack-Connect support', 'Shared inbox', 'Ticketing + SLAs', 'Knowledge base + AI'], wedge: 'Week-1: a Slack-Connect message → ticket router with a shared inbox for B2B support teams.', competitors: ['Intercom', 'Zendesk', 'Plain', 'Thena'] },
];
