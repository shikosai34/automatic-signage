export type CommercialCandidate = {
  id: number
  title: string
  circle_slug?: string
  circle_name?: string
  media_path?: string
  duration_seconds?: number
  preference_score?: number
  circle_preference?: number
  play_count?: number
  recent_count?: number
  max_per_break?: number
  circle_cut_path?: string
  is_active?: number
}

export type SelectedCommercial = Pick<CommercialCandidate,
  'id' | 'title' | 'circle_slug' | 'circle_name' | 'media_path' | 'circle_cut_path'
> & { duration_seconds: number }

const boundedInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

export function secondsUntilStart(startMinute: number, nowMinute: number, nowSecond: number) {
  return Math.max(0, startMinute * 60 - (nowMinute * 60 + nowSecond))
}

export function selectCommercials(
  candidates: CommercialCandidate[],
  gapSeconds: number,
  alreadyPlayedIds: ReadonlySet<number> = new Set(),
) {
  let remaining = Math.max(0, Math.floor(gapSeconds))
  if (remaining === 0) return [] as SelectedCommercial[]

  const active = candidates.filter((ad) => ad.is_active === undefined || Number(ad.is_active) === 1)
  const averagePlays = active.length
    ? active.reduce((total, ad) => total + boundedInteger(ad.play_count, 0, 0, 1_000_000), 0) / active.length
    : 0
  const ranked = active
    .filter((ad) => !alreadyPlayedIds.has(ad.id))
    .map((ad) => ({
      ad,
      duration: boundedInteger(ad.duration_seconds, 15, 1, 3600),
      score: boundedInteger(ad.preference_score, 0, -10, 10) * 3
        + boundedInteger(ad.circle_preference, 0, -10, 10) * 2
        - boundedInteger(ad.recent_count, 0, 0, 1_000_000) * 8
        + (averagePlays - boundedInteger(ad.play_count, 0, 0, 1_000_000)) * 0.5,
    }))
    .sort((a, b) => b.score - a.score || a.duration - b.duration || a.ad.id - b.ad.id)

  const selected: SelectedCommercial[] = []
  const perCircle = new Map<string, number>()
  for (const { ad, duration } of ranked) {
    const circleKey = ad.circle_slug || `ad-${ad.id}`
    const circleCount = perCircle.get(circleKey) || 0
    const circleLimit = boundedInteger(ad.max_per_break, 1, 1, 20)
    if (duration > remaining || circleCount >= circleLimit) continue

    selected.push({
      id: ad.id,
      title: ad.title,
      circle_slug: ad.circle_slug,
      circle_name: ad.circle_name,
      media_path: ad.media_path,
      duration_seconds: duration,
      circle_cut_path: ad.circle_cut_path,
    })
    remaining -= duration
    perCircle.set(circleKey, circleCount + 1)
    if (remaining === 0) break
  }
  return selected
}
