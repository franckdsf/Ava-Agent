/**
 * The vocabulary Joob tags postings with, so most of them never reach a model.
 *
 * **Every source's own tags are unusable, and that is measured, not assumed.**
 * Remotive returned a *graphic design* role carrying `.Net`, `golang`, `php`,
 * `rust` and `unity`; RemoteOK returned a construction **estimator** tagged
 * `golang`, `infosec`, `dev`, `engineer` and `technical`. Boards let employers
 * tag freely and agencies tag everything, so a source tag says nothing. These
 * are derived from the title and body instead, by this file's vocabulary, and
 * the source's tags are kept only as an audit trail.
 *
 * Hand-curated on purpose. A model could generate this, and then the thing
 * deciding what is worth spending a model on would itself cost a model call per
 * posting — which is the expense the whole stage exists to avoid.
 *
 * Matching is word-boundary and case-insensitive. Multi-word entries match as
 * phrases. Add a term by adding it here; nothing else changes.
 */

/**
 * What kind of job it is, matched against the **title only**.
 *
 * Title-only is load-bearing and was the first thing to get wrong. A backend
 * role's description routinely says "you will work alongside our React team",
 * and a description-wide match tags it `frontend` — so a reader filtering on
 * frontend gets backend jobs, and the filter that was meant to save model calls
 * spends them instead. The title is the one place a board states the discipline.
 */
export const DISCIPLINES: Record<string, string[]> = {
  frontend: ['frontend', 'front end', 'front-end', 'ui engineer', 'web developer', 'react developer'],
  backend: ['backend', 'back end', 'back-end', 'server side', 'api engineer'],
  fullstack: ['fullstack', 'full stack', 'full-stack'],
  mobile: ['mobile', 'ios', 'android', 'react native', 'flutter'],
  devops: ['devops', 'sre', 'site reliability', 'platform engineer', 'infrastructure engineer', 'cloud engineer'],
  data: ['data engineer', 'data analyst', 'analytics engineer', 'data scientist', 'business intelligence'],
  ml: ['machine learning', 'ml engineer', 'ai engineer', 'applied scientist', 'research scientist', 'deep learning'],
  security: ['security', 'infosec', 'appsec', 'penetration test'],
  qa: ['qa engineer', 'quality assurance', 'test engineer', 'sdet'],
  design: ['designer', 'design lead', 'ux', 'ui/ux', 'product design'],
  product: ['product manager', 'product owner', 'head of product'],
  engineering: ['software engineer', 'software developer', 'engineer', 'developer', 'programmer'],
}

/**
 * Disciplines that are not software work at all.
 *
 * Matched against the title like the rest, and used to reject rather than to
 * describe. This is what removes the private-banking advisers and accountants a
 * general board carries — cheaply, before anything reads them.
 */
export const NON_TECHNICAL: string[] = [
  'accountant', 'accounting', 'bookkeep', 'banking', 'berater', 'sachbearbeiter',
  'sales representative', 'account executive', 'business development', 'recruiter',
  'customer support', 'customer success', 'call center', 'teller',
  'nurse', 'medical', 'physician', 'therapist', 'dental',
  'driver', 'warehouse', 'estimator', 'construction', 'electrician', 'technician',
  'paralegal', 'attorney', 'lawyer',
  'copywriter', 'content writer', 'social media', 'seo specialist',
  'teacher', 'tutor', 'instructor',
  'human resources', 'payroll', 'talent acquisition',
]

/**
 * Technologies, matched against **title and body**.
 *
 * Body-wide is right here and wrong for disciplines above: a stack is genuinely
 * listed in the requirements, and a posting that never names a technology
 * anywhere is one that does not require it.
 *
 * **Short ambiguous names are deliberately absent or narrowed.** Bare `go`, `r`
 * and `c` match ordinary prose in every job advert ever written — "go the extra
 * mile", "C level" — so Go is matched only as `golang` or as `go` immediately
 * before a role noun. Anything that cannot be matched safely is better missing
 * than wrong: a missing tag costs one model call, a wrong one silently discards
 * a posting.
 */
export const TECHNOLOGIES: Record<string, string[]> = {
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
}

/** Seniority, matched against the **title only** for the same reason disciplines are. */
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
   * Body characters scanned for technology terms.
   *
   * The stack is stated in the first part of an advert; past this is benefits,
   * culture and the equal-opportunity statement, where a stray technology name
   * is far more likely to be a mention than a requirement.
   */
  bodyScanChars: 4_000,
} as const
