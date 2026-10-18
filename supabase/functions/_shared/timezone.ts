// ── Conversión de hora de pared a UTC, correcta con horario de verano ──────
// America/Matamoros (y otras ciudades de la zona fronteriza) SÍ observan
// horario de verano (alineado con EE.UU.), a diferencia del resto de México.
// Un offset fijo (ej. -06:00 todo el año) queda mal durante esos meses —
// por eso esto usa Intl para calcular el offset real en la fecha dada, igual
// que ya hace el dashboard (zonedWallTimeToUtcIso en dashboard/index.html).

export function zonedWallTimeToUtcIso(
  year: number, month0: number, day: number, hour: number, minute: number, second: number,
  timeZone: string,
): string {
  const asUTC = Date.UTC(year, month0, day, hour, minute, second)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = fmt.formatToParts(new Date(asUTC)).reduce((acc: Record<string, string>, p) => {
    acc[p.type] = p.value
    return acc
  }, {})
  const asIfUtcInZone = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  )
  const offsetMs = asIfUtcInZone - asUTC
  return new Date(asUTC - offsetMs).toISOString()
}

// fecha: "YYYY-MM-DD", hora: "HH:MM" o "HH:MM:SS" — ambas como las entiende
// el cliente/el modelo, interpretadas como hora de pared en `timeZone`.
export function fechaHoraToUtcIso(fecha: string, hora: string, timeZone: string): string {
  const [y, m, d] = fecha.split('-').map(Number)
  const [hh, mm, ss] = hora.split(':').map(Number)
  return zonedWallTimeToUtcIso(y, m - 1, d, hh, mm, ss || 0, timeZone)
}

// ── Dirección inversa: UTC → hora de pared, para crons de horario fijo ─────
// Un cron en pg_cron corre en UTC; para decidir "¿ya es la hora X en
// America/Matamoros?" sin que el cambio de horario (1 nov) lo desalinee,
// hay que calcular la hora local en el momento en que corre, no sumar/restar
// un offset fijo.
export interface LocalTimeParts {
  dateStr: string // "YYYY-MM-DD" en timeZone
  weekday: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
  hhmm: string // "HH:MM" en timeZone
  minutesOfDay: number
}

const WEEKDAY_MAP: Record<string, LocalTimeParts['weekday']> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
}

export function getLocalTimeParts(timeZone: string, at: Date = new Date()): LocalTimeParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const parts = fmt.formatToParts(at).reduce((acc: Record<string, string>, p) => {
    acc[p.type] = p.value
    return acc
  }, {})
  const hour = Number(parts.hour)
  const minute = Number(parts.minute)
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAY_MAP[parts.weekday] ?? 'mon',
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    minutesOfDay: hour * 60 + minute,
  }
}

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + (m || 0)
}
