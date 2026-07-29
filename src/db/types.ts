import type { Article, NewArticle } from './schema.js'

export type {
  Article,
  ArticleBeatRow,
  Beat as BeatRow,
  BeatFeedRow,
  DeliveryKind,
  FeedStateRow,
  NewArticle,
  Vote,
} from './schema.js'

/**
 * An article as discovered from a feed, before clustering, ranking, or delivery.
 *
 * Carries no beat. Which beats a story belongs to is decided by *which feeds
 * carried it*, and that fan-out is expressed as `BeatLink` rows written
 * alongside — one story, N links. Before the split this type had a
 * `categorySlug` on it, which is exactly what made a story belong to one beat
 * and no more.
 */
export type DiscoveredArticle = Pick<
  NewArticle,
  'id' | 'feedUrl' | 'source' | 'title' | 'link' | 'excerpt' | 'content' | 'imageUrl' | 'publishedAt'
>

/** One (article, beat) attachment, with the subtopic its feed pins — usually none. */
export interface BeatLink {
  articleId: string
  beatSlug: string
  subtopic: string | null
}

/** An article awaiting one beat's verdict, carrying that beat's pinned subtopic. */
export type PendingArticle = Article & { subtopic: string | null }

/** The ranker's verdict on a single article, for one beat. */
export interface ArticleRanking {
  id: string
  score: number
  subtopic: string
  reason: string
}
