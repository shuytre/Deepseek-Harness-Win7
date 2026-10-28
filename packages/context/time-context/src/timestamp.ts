/** ISO-shaped time-context timestamp formatting shared by production and replay validation. */

type TimestampPart = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'timeZoneName' | 'year'

/**
 * Create the exact formatter used by durable time-context readings.
 * @param timeZone - Explicit display zone, or `undefined` for the process fallback.
 * @returns A formatter with stable numeric local fields and long numeric offset.
 */
/** Fields both offset formats share; the zone name is chosen per runtime. */
const TIMESTAMP_FIELDS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
} as const

export function createTimestampFormatter(timeZone?: string): Intl.DateTimeFormat {
  const zone = timeZone === undefined ? {} : { timeZone }
  try {
    return new Intl.DateTimeFormat('en-US', { ...zone, ...TIMESTAMP_FIELDS, timeZoneName: 'longOffset' })
  } catch {
    // `longOffset` arrived with ICU 71: an older runtime refuses the option
    // outright, and the whole plugin failed to apply with "failed to resolve the
    // system time zone". `shortOffset` carries the same information in a shorter
    // form, which `formatTimestamp` normalizes back to `+HH:MM`.
    return new Intl.DateTimeFormat('en-US', { ...zone, ...TIMESTAMP_FIELDS, timeZoneName: 'shortOffset' })
  }
}

/**
 * Normalize an offset label to `+HH:MM`.
 * @param label - `timeZoneName` part, `GMT+08:00` or the older `GMT+8` / `GMT`.
 * @returns The offset without its `GMT` prefix.
 */
function normalizeOffset(label: string): string {
  const match = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/u.exec(label)
  if (match === null) return label.startsWith('GMT') ? label.slice(3) : label
  const sign = match[1] ?? '+'
  const hours = (match[2] ?? '0').padStart(2, '0')
  const minutes = match[3] ?? '00'
  return `${sign}${hours}:${minutes}`
}

/**
 * Format an epoch millisecond value as an ISO-shaped timestamp with offset and IANA zone.
 * @param now - Epoch milliseconds to display.
 * @param formatter - Formatter created for `timeZone`.
 * @param timeZone - Canonical zone label carried in brackets.
 * @returns The durable timestamp text.
 */
export function formatTimestamp(now: number, formatter: Intl.DateTimeFormat, timeZone: string): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(part => [part.type, part.value]),
  ) as Record<TimestampPart, string>
  const offset = normalizeOffset(parts.timeZoneName)
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${offset}[${timeZone}]`
}
