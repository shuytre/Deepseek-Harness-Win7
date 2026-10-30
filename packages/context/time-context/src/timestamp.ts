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
  // The offset is computed, not asked for: `timeZoneName: 'longOffset'` needs
  // ICU 72 and `'shortOffset'` needs the same, so the shipped Node 16 (ICU 71)
  // refused both and the plugin never applied — three Agent presets failed to
  // load with "failed to resolve the system time zone" on a machine whose zone
  // was Asia/Shanghai all along.
  return new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    ...TIMESTAMP_FIELDS,
  })
}

/**
 * Offset of a zone from UTC at one instant.
 * @param now - Epoch milliseconds.
 * @param timeZone - IANA zone, or `undefined` for the process zone.
 * @returns Offset in minutes, east of UTC positive.
 */
function zoneOffsetMinutes(now: number, timeZone?: string): number {
  if (timeZone === undefined || timeZone === Intl.DateTimeFormat().resolvedOptions().timeZone) {
    return -new Date(now).getTimezoneOffset()
  }
  const parts = new Intl.DateTimeFormat('en-US', { ...TIMESTAMP_FIELDS, timeZone }).formatToParts(now)
  const field = (type: TimestampPart): number => Number(parts.find(part => part.type === type)?.value ?? '0')
  const asUtc = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'))
  return Math.round((asUtc - Math.round(now / 1000) * 1000) / 60_000)
}

/**
 * Render an offset as `+HH:MM`.
 * @param minutes - Offset in minutes, east of UTC positive.
 * @returns The offset text.
 */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const rest = String(absolute % 60).padStart(2, '0')
  return `${sign}${hours}:${rest}`
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
  const offset = formatOffset(zoneOffsetMinutes(now, timeZone))
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${offset}[${timeZone}]`
}
