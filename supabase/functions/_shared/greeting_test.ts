import { assert, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { GREETING_REGEX } from './greeting.ts'

// Saludos reales — deben contar como saludo.
const SALUDOS = [
  'hola',
  'Hola!',
  'buenas',
  'buenos',
  'buenas tardes',
  'buenos días',
  'buenas noches',
  'buen día',
  'buen dia',
  'qué tal',
  'hey',
  'saludos',
]

// No son saludos — "bueno"/"buena" sin la "s" son muletillas o adjetivos,
// no deben disparar la lógica de saludo (bug reportado: "bueno, sí" y
// "buena idea" se tomaban como saludo).
const NO_SALUDOS = [
  'bueno, sí',
  'buena idea',
  'bueno',
  'buena',
  'esta buena la propuesta',
]

Deno.test('GREETING_REGEX reconoce saludos reales', () => {
  for (const texto of SALUDOS) {
    assert(GREETING_REGEX.test(texto), `debería reconocer "${texto}" como saludo`)
  }
})

Deno.test('GREETING_REGEX no confunde "bueno/buena" sin "s" con un saludo', () => {
  for (const texto of NO_SALUDOS) {
    assertFalse(GREETING_REGEX.test(texto), `"${texto}" NO debería contar como saludo`)
  }
})
