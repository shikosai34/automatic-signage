import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectCommercials, secondsUntilStart, type CommercialCandidate } from './cm-selection.js'

const ad = (id: number, values: Partial<CommercialCandidate> = {}): CommercialCandidate => ({
  id,
  title: `CM ${id}`,
  media_path: `cm-${id}.mp4`,
  circle_slug: `circle-${id}`,
  duration_seconds: 15,
  preference_score: 0,
  circle_preference: 0,
  play_count: 0,
  recent_count: 0,
  max_per_break: 2,
  is_active: 1,
  ...values,
})

test('CM preference and circle preference determine the order', () => {
  const chosen = selectCommercials([
    ad(1, { preference_score: 10 }),
    ad(2, { circle_preference: 10 }),
    ad(3, { preference_score: -10, circle_preference: -10 }),
  ], 15)
  assert.equal(chosen[0]?.id, 1)
  assert.deepEqual(chosen.map((item) => item.id), [1])
})

test('recent plays reduce repetition and prior plays in this break are excluded', () => {
  const chosen = selectCommercials([
    ad(1, { recent_count: 3 }),
    ad(2),
    ad(3),
  ], 30, new Set([3]))
  assert.deepEqual(chosen.map((item) => item.id), [2, 1])
})

test('a circle dislike is not overridden by synchronization behavior', () => {
  const chosen = selectCommercials([
    ad(1, { circle_slug: 'disliked', circle_preference: -10 }),
    ad(2, { circle_slug: 'neutral' }),
  ], 15)
  assert.equal(chosen[0]?.circle_slug, 'neutral')
})

test('skips items that do not fit and never exceeds the remaining time', () => {
  const chosen = selectCommercials([
    ad(1, { duration_seconds: 75, preference_score: 10 }),
    ad(2, { duration_seconds: 30 }),
    ad(3, { duration_seconds: 30 }),
  ], 60)
  assert.deepEqual(chosen.map((item) => item.id), [2, 3])
  assert.ok(chosen.reduce((sum, item) => sum + item.duration_seconds, 0) <= 60)
})

test('respects per-circle limits and ignores inactive ads', () => {
  const chosen = selectCommercials([
    ad(1, { circle_slug: 'same', max_per_break: 1, preference_score: 10 }),
    ad(2, { circle_slug: 'same', max_per_break: 1 }),
    ad(3, { is_active: 0, preference_score: 10 }),
  ], 45)
  assert.deepEqual(chosen.map((item) => item.id), [1])
})

test('supports empty CM windows and second-accurate program deadlines', () => {
  assert.deepEqual(selectCommercials([ad(1)], 0), [])
  assert.equal(secondsUntilStart(600, 599, 45), 15)
  assert.equal(secondsUntilStart(600, 600, 0), 0)
  assert.equal(secondsUntilStart(600, 601, 0), 0)
})
