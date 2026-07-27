import type { NewItem } from './schema.js'

export type { DeliveryKind, FeedStateRow, Item, NewItem, Vote } from './schema.js'

/** An item as discovered from a feed, before clustering, ranking, or delivery. */
export type DiscoveredItem = Pick<
  NewItem,
  | 'id'
  | 'categorySlug'
  | 'feedUrl'
  | 'source'
  | 'title'
  | 'link'
  | 'excerpt'
  | 'content'
  | 'imageUrl'
  | 'publishedAt'
  | 'subtopic'
>

/** The ranker's verdict on a single item. */
export interface ItemRanking {
  id: string
  score: number
  subtopic: string
  reason: string
}
