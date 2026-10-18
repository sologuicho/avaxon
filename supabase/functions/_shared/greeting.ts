// Detecta un saludo real — "s" obligatoria en "buenas/buenos" (sola o con
// día/tarde/noche) para no confundir "bueno, sí" / "buena idea" con un
// saludo. "buen día" (singular, sin s) es la única excepción explícita.
// Ver pruebas en greeting_test.ts.
export const GREETING_REGEX = /\b(hola+|buen[oa]s(?:\s*(d[ií]as?|tardes|noches))?|buen\s*d[ií]a|qu[eé]\s*tal|hey|saludos)\b/i
