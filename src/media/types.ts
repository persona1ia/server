export interface MediaItem {
  id: string
  url: string
  size: number
  kind: 'image'
  mimeType: string
  createdAt: string
}

export interface StoredMedia {
  data: Buffer
  item: MediaItem
}

export interface MediaRow {
  id: string
  size: number
  kind: 'image'
  mime_type: string
  created_at: string
}

export interface StoredMediaRow extends MediaRow {
  data: Uint8Array
}
