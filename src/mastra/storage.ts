import { MastraCompositeStore } from '@mastra/core/storage'
import { LibSQLStore, ObservabilityLibSQL } from '@mastra/libsql'
import { env } from '../config/env.js'
import { rawClient } from '../db/client.js'
import { resolveDbUrl } from '../lib/libsql-url.js'

/**
 * Two databases, split by lifetime rather than by domain:
 *
 * - **Data** (`AVA_DATA_DB_URL`) holds everything worth keeping — memory,
 *   working memory, workflow state, scores — next to the app's own tables, on
 *   the same connection Drizzle uses.
 * - **Traces** (`AVA_TRACES_DB_URL`) is high-volume and disposable. Keeping it
 *   separate means trace churn never competes for locks with real data, and the
 *   file can be deleted at any time.
 */
export const storage = new MastraCompositeStore({
  id: 'ava-storage',
  default: new LibSQLStore({ id: 'ava-data', client: rawClient() }),
  domains: {
    observability: new ObservabilityLibSQL({ url: resolveDbUrl(env.AVA_TRACES_DB_URL) }),
  },
})
