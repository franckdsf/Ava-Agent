/**
 * The vocabularies Joob tags postings with, so most of them never reach a model.
 *
 * **Every source's own tags are unusable, and that is measured, not assumed.**
 * Remotive returned a *graphic design* role carrying `.Net`, `golang`, `php`,
 * `rust` and `unity`; RemoteOK returned a construction **estimator** tagged
 * `golang`, `infosec`, `dev`, `engineer` and `technical`. Boards let employers
 * tag freely and agencies tag everything, so a source tag says nothing. These
 * are derived from the title and body instead, by this file's vocabularies, and
 * the source's tags are kept only as an audit trail.
 *
 * Hand-curated on purpose. A model could generate this, and then the thing
 * deciding what is worth spending a model on would itself cost a model call per
 * posting — which is the expense the whole stage exists to avoid. A *search* is
 * model-parsed, because that happens once per `/target` rather than once per
 * posting; see `domain` in `job-targeter.ts`.
 *
 * Matching is word-boundary and case-insensitive. Multi-word entries match as
 * phrases. Add a term by adding it here; nothing else changes.
 *
 * ---
 *
 * **A domain declares what it is, never what it is not.** This file used to hold
 * one software vocabulary plus a `NON_TECHNICAL` list of everything software
 * isn't, and that shape had two defects. It only worked for one field — a
 * chemistry search got no saving at all, because nothing recognised an
 * accountant as an accountant. And the exclusion list decided which professions
 * the reader was allowed to want: `dental` was literally in it, so
 * `/target dentist in Lyon` rejected every dentist with the reason "not a
 * software role" ([ADR-0028](../../docs/decisions/0028-a-search-decides-what-counts-as-a-job.md)).
 *
 * Inverting it fixes both at once. Every domain lists its own titles, a posting
 * is tagged with whichever domains it matches, and rejection becomes a set
 * intersection against the search's own domain rather than an opinion held by
 * one field about all the others. The saving is preserved and now runs in every
 * direction: the accountant is skipped for a chemistry search too, which under
 * the old shape it never was.
 *
 * The rule from ADR-0028 still holds and is what this shape makes structural:
 * **the taxonomy describes postings, and only a search may reject them.**
 */

/** One field of work, as a vocabulary that can recognise its own postings. */
export interface DomainVocabulary {
  /** Named in a rejection reason — "looks like a healthcare role". Lowercase. */
  label: string
  /**
   * What kind of job it is, matched against the **title only**, and the sole
   * source of domain membership.
   *
   * Title-only is load-bearing and was the first thing to get wrong. A backend
   * role's description routinely says "you will work alongside our React team",
   * and a description-wide match tags it `frontend` — so a reader filtering on
   * frontend gets backend jobs, and the filter that was meant to save model
   * calls spends them instead. The title is the one place a board states the
   * discipline, which is also why it is the only place trusted to say what field
   * a posting belongs to.
   */
  disciplines: Record<string, string[]>
  /**
   * Tools, techniques and technologies, matched against **title and body**.
   *
   * Body-wide is right here and wrong for disciplines above: a stack or a set of
   * instruments is genuinely listed in the requirements, and a posting that
   * never names one anywhere does not require it.
   *
   * **These do not confer domain membership.** A polymer advert asking for
   * Python in its body is not a software posting, and a domain decided from the
   * body would make it one. They are tagged for CV overlap ranking
   * (`rankByCvOverlap`), which is a *prioritisation* and may never reject.
   *
   * Optional: the recognise-and-reject domains below carry none. Their whole job
   * is to be identified from a title, and a half-curated list of finance tools
   * would earn nothing while adding ways to be wrong.
   */
  skills?: Record<string, string[]>
}

/**
 * Software engineering.
 *
 * **Short ambiguous names are deliberately absent or narrowed.** Bare `go`, `r`
 * and `c` match ordinary prose in every job advert ever written — "go the extra
 * mile", "C level" — so Go is matched only as `golang` or as `go` immediately
 * before a role noun. Anything that cannot be matched safely is better missing
 * than wrong: a missing tag costs one model call, a wrong one silently discards
 * a posting.
 *
 * Bare `engineer` stays in `engineering` despite matching "Process Engineer" and
 * "Chemical Engineer", which now also match `chemistry`. That overlap is
 * harmless under an intersection rule — both searches keep the posting — and
 * removing it would drop real software adverts whose title is just "Engineer".
 */
const software: DomainVocabulary = {
  label: 'software',
  disciplines: {
    frontend: ['frontend', 'front end', 'front-end', 'ui engineer', 'web developer', 'react developer'],
    backend: ['backend', 'back end', 'back-end', 'server side', 'api engineer'],
    fullstack: ['fullstack', 'full stack', 'full-stack'],
    mobile: ['mobile developer', 'mobile engineer', 'ios', 'android', 'react native', 'flutter'],
    devops: ['devops', 'sre', 'site reliability', 'platform engineer', 'infrastructure engineer', 'cloud engineer'],
    data: ['data engineer', 'data analyst', 'analytics engineer', 'data scientist', 'business intelligence'],
    ml: ['machine learning', 'ml engineer', 'ai engineer', 'deep learning'],
    security: ['infosec', 'appsec', 'penetration test', 'security engineer', 'security analyst'],
    qa: ['qa engineer', 'quality assurance engineer', 'test engineer', 'sdet'],
    design: ['designer', 'design lead', 'ux', 'ui/ux', 'product design'],
    product: ['product manager', 'product owner', 'head of product'],
    engineering: ['software engineer', 'software developer', 'engineer', 'developer', 'programmer'],
  },
  skills: {
    typescript: ['typescript'],
    javascript: ['javascript', 'ecmascript'],
    react: ['react.js', 'reactjs', 'react'],
    vue: ['vue.js', 'vuejs', 'vue'],
    angular: ['angular'],
    svelte: ['svelte'],
    nextjs: ['next.js', 'nextjs'],
    node: ['node.js', 'nodejs'],
    python: ['python', 'django', 'fastapi'],
    golang: ['golang', 'go developer', 'go engineer', 'go backend'],
    rust: ['rust'],
    java: ['java', 'spring boot'],
    kotlin: ['kotlin'],
    swift: ['swift', 'swiftui'],
    php: ['php', 'laravel', 'symfony'],
    ruby: ['ruby', 'rails'],
    elixir: ['elixir', 'phoenix'],
    dotnet: ['.net', 'c#', 'asp.net'],
    cpp: ['c++'],
    scala: ['scala'],
    aws: ['aws', 'amazon web services'],
    gcp: ['google cloud', 'gcp'],
    azure: ['azure'],
    kubernetes: ['kubernetes', 'k8s'],
    docker: ['docker'],
    terraform: ['terraform'],
    graphql: ['graphql'],
    sql: ['postgresql', 'postgres', 'mysql', 'sql server'],
    nosql: ['mongodb', 'dynamodb', 'cassandra', 'redis'],
  },
}

/**
 * Chemistry, materials and the lab.
 *
 * The second real field, and the one that proves the shape generalises: it is
 * curated to the same depth as `software` rather than to the depth of the
 * recognise-and-reject set below.
 *
 * **`technician` appears nowhere, and its absence is the ADR-0028 bug fix.** It
 * was in the old `NON_TECHNICAL` list, so *Lab Technician — Polymer Analysis*
 * was flagged not-software and rejected outright. It cannot simply move here
 * either: a technician is as often field service or IT as it is a lab. A bare
 * `technician` confers no domain in any vocabulary, which is this file's own
 * rule — anything that cannot be matched safely is better missing than wrong.
 *
 * `skills` are instruments and techniques, which is what a chemistry advert
 * states where a software advert states a stack. Acronyms are only included
 * where they are unambiguous in prose: `hplc`, `nmr` and `xrd` are safe, while
 * `sem`, `dsc` and `tga` are spelled out because the three-letter forms collide
 * with search-engine marketing and with ordinary words.
 */
const chemistry: DomainVocabulary = {
  label: 'chemistry',
  disciplines: {
    analytical: ['analytical chemist', 'analytical chemistry', 'lab analyst', 'laboratory analyst'],
    organic: ['organic chemist', 'organic chemistry', 'synthetic chemist', 'medicinal chemist'],
    polymer: ['polymer chemist', 'polymer scientist', 'polymer engineer', 'plastics engineer'],
    materials: ['materials scientist', 'materials engineer', 'materials chemist', 'metallurgist'],
    process: ['process chemist', 'process engineer', 'chemical engineer', 'production chemist'],
    formulation: ['formulation chemist', 'formulation scientist', 'formulation development'],
    quality: ['quality control chemist', 'qc analyst', 'qc chemist', 'quality control analyst'],
    regulatory: ['regulatory affairs', 'reach compliance', 'product stewardship'],
    computational: ['computational chemist', 'cheminformatics', 'molecular modelling', 'molecular modeling'],
    research: ['research chemist', 'research scientist', 'r&d chemist', 'laboratory scientist'],
  },
  skills: {
    chromatography: ['hplc', 'uplc', 'chromatography', 'gc-ms', 'lc-ms', 'gpc', 'size exclusion'],
    spectroscopy: ['nmr', 'ftir', 'infrared spectroscopy', 'uv-vis', 'raman', 'icp-ms', 'icp-oes'],
    massspec: ['mass spectrometry', 'mass spectrometer'],
    thermal: ['differential scanning calorimetry', 'thermogravimetric', 'thermal analysis'],
    microscopy: ['scanning electron', 'transmission electron', 'atomic force microscopy'],
    diffraction: ['xrd', 'x-ray diffraction', 'crystallography'],
    rheology: ['rheology', 'rheometer', 'viscometry'],
    polymerisation: ['polymerisation', 'polymerization', 'extrusion', 'compounding', 'injection moulding'],
    catalysis: ['catalysis', 'catalyst development', 'heterogeneous catalysis'],
    synthesis: ['organic synthesis', 'scale-up', 'process development', 'kilo lab'],
    quality: ['iso 17025', 'gmp', 'glp', 'lims', 'method validation'],
    biodegradation: ['biodegradation', 'depolymerisation', 'depolymerization', 'recycling', 'circular economy'],
  },
}

/**
 * The recognise-and-reject set.
 *
 * These exist for one purpose: a general board carries private-banking advisers,
 * accountants and clerical roles, and recognising them cheaply is the single
 * biggest saving in the pipeline. They are titles only and deliberately shallow
 * — a domain here has to be good enough to say "this is not what you asked for",
 * not good enough to run a search of its own.
 *
 * Promoting one to a real field is exactly the work `chemistry` shows: add
 * `skills`, deepen `disciplines`, and nothing else in the codebase changes.
 *
 * **Terms are allowed to appear in more than one domain**, and ambiguous ones
 * should. Under an intersection rule a posting matching two domains is kept by
 * a search in either of them, so the cost of listing `construction` under both
 * trades and logistics is nothing, while the cost of guessing wrong is a
 * posting the reader never learns existed.
 */
const healthcare: DomainVocabulary = {
  label: 'healthcare',
  disciplines: {
    // `medical` was in the old exclusion list, was dropped in the rewrite for
    // fear of catching "Medical Device Engineer", and `pnpm jobs:check` found
    // the cost immediately: *Medical Contact Center Assistant I* survived a
    // software search. The fear was unfounded under an intersection rule — that
    // title also matches software's bare `engineer`, holds both domains, and is
    // kept by a search in either.
    clinical: ['nurse', 'nursing', 'physician', 'clinician', 'midwife', 'paramedic', 'medical'],
    allied: ['therapist', 'physiotherap', 'radiograph', 'radiolog', 'dental', 'dentist', 'optometr'],
    pharmacy: ['pharmacist', 'pharmacy technician', 'dispenser'],
    care: ['caregiver', 'care assistant', 'support worker', 'healthcare assistant'],
    veterinary: ['veterinar'],
  },
}

const finance: DomainVocabulary = {
  label: 'finance',
  disciplines: {
    accounting: ['accountant', 'accounting', 'bookkeep', 'auditor', 'financial controller'],
    banking: ['banking', 'teller', 'loan officer', 'credit analyst', 'mortgage adviser'],
    advisory: ['berater', 'sachbearbeiter', 'financial adviser', 'financial advisor', 'wealth manager'],
    treasury: ['treasury', 'actuary', 'tax adviser', 'tax advisor', 'payroll'],
  },
}

const sales: DomainVocabulary = {
  label: 'sales',
  disciplines: {
    field: ['sales representative', 'sales manager', 'account executive', 'business development'],
    inside: ['inside sales', 'telesales', 'sales development representative'],
    account: ['account manager', 'key account'],
    support: [
      'customer support',
      'customer success',
      'call center',
      'call centre',
      // Boards use these interchangeably and a list holding only one of them
      // silently misses half the volume — found by `pnpm jobs:check`.
      'contact center',
      'contact centre',
      'help desk',
    ],
  },
}

const legal: DomainVocabulary = {
  label: 'legal',
  disciplines: {
    practice: ['paralegal', 'attorney', 'lawyer', 'solicitor', 'barrister', 'notary'],
    inhouse: ['legal counsel', 'general counsel', 'contract manager'],
  },
}

const education: DomainVocabulary = {
  label: 'education',
  disciplines: {
    teaching: ['teacher', 'tutor', 'instructor', 'lecturer', 'teaching assistant'],
    academic: ['professor', 'academic coordinator'],
  },
}

const trades: DomainVocabulary = {
  label: 'skilled trades',
  disciplines: {
    building: ['electrician', 'plumber', 'welder', 'carpenter', 'construction', 'estimator', 'hvac'],
    mechanical: ['mechanic', 'machinist', 'fitter', 'maintenance engineer'],
  },
}

const logistics: DomainVocabulary = {
  label: 'logistics',
  disciplines: {
    warehouse: ['warehouse', 'forklift', 'picker', 'packer'],
    transport: ['driver', 'courier', 'dispatcher', 'fleet manager'],
    supply: ['supply chain', 'logistics coordinator', 'procurement officer'],
  },
}

/**
 * People operations.
 *
 * **Beyond the seven recognise-and-reject domains agreed for this pass**, and
 * called out rather than folded quietly into `sales`. Recruiters and payroll
 * clerks are a large share of a general board's volume and belong to neither
 * sales nor finance; dropping them would have lost real saving. Delete this
 * const and its `DOMAINS` entry if the extra vocabulary is not wanted.
 */
const people: DomainVocabulary = {
  // "people operations" rather than "HR" so the rejection reason reads
  // "looks like a people operations role" — the label is dropped straight into
  // a sentence after "a", and "a HR role" is what the short form produced.
  label: 'people operations',
  disciplines: {
    recruiting: ['recruiter', 'talent acquisition', 'sourcer'],
    hr: ['human resources', 'hr manager', 'hr business partner', 'people operations'],
  },
}

/**
 * Every vocabulary, keyed by the id a search stores in `job_searches.domain`.
 *
 * The keys are the closed set the targeter must choose from — `domainIds()`
 * renders them into its prompt and `isKnownDomain()` validates the answer on the
 * way back, the same discipline the news ranker follows when it discards an
 * article id it was not given. Adding a field here is what makes it available to
 * `/target`; nothing else needs to change.
 */
export const DOMAINS: Record<string, DomainVocabulary> = {
  software,
  chemistry,
  healthcare,
  finance,
  sales,
  legal,
  education,
  trades,
  logistics,
  people,
}

/** The ids a search's `domain` may hold. */
export function domainIds(): string[] {
  return Object.keys(DOMAINS)
}

/** Whether a model-supplied domain is one this file actually knows. */
export function isKnownDomain(value: string | null | undefined): boolean {
  return typeof value === 'string' && value in DOMAINS
}

/** How a domain is named in a rejection reason. Falls back to the raw id. */
export function domainLabel(id: string): string {
  return DOMAINS[id]?.label ?? id
}

/**
 * Seniority, matched against the **title only** for the same reason disciplines
 * are — and shared by every domain rather than repeated inside each.
 *
 * A junior chemist and a junior developer are junior in the same words. The
 * bands are one of the few things about a job advert that genuinely do not vary
 * by field, and duplicating them per domain would guarantee they drift apart.
 */
export const SENIORITY: Record<string, string[]> = {
  intern: ['intern', 'internship', 'working student', 'werkstudent', 'apprentice'],
  junior: ['junior', 'graduate', 'entry level', 'associate'],
  mid: ['mid level', 'midlevel'],
  senior: ['senior', 'sr.', 'sr '],
  staff: ['staff'],
  principal: ['principal'],
  lead: ['lead', 'tech lead', 'team lead'],
  manager: ['manager', 'head of', 'director', 'vp of', 'chief'],
}

export const jobTaxonomy = {
  /**
   * Body characters scanned for skill terms.
   *
   * The stack or the instrument list is stated in the first part of an advert;
   * past this is benefits, culture and the equal-opportunity statement, where a
   * stray technology name is far more likely to be a mention than a requirement.
   */
  bodyScanChars: 4_000,
} as const
