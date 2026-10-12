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
