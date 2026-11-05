#!/usr/bin/env bash
# Valida la migración de "Promocionar publicaciones"
# (supabase/migrations/20261104120000_promociones_meta_schema.sql) contra un
# volcado REAL del esquema de producción (solo esquema, sin datos ni
# secretos -- ver docs/promociones-meta.md §9 para cómo generarlo).
#
# Qué hace (todo en Docker LOCAL, nunca toca producción):
#   1. Vacía temporalmente supabase/migrations/ y levanta un Postgres local
#      limpio vía `supabase start` (da auth.users, auth.uid(), extensiones
#      reales -- la plataforma base de Supabase, no las migraciones de este
#      repo).
#   2. Restaura supabase/migrations/ a su estado real inmediatamente
#      (con `trap`, incluso si el script falla a la mitad).
#   3. Aplica el volcado de esquema real que le diste (todo lo que ya existe
#      en prod, incluyendo publicaciones_redes).
#   4. Aplica la migración de esta feature
#      (20261104120000_promociones_meta_schema.sql) -- la primera vez de
#      verdad contra una forma real del esquema de producción, no un stub.
#   5. La vuelve a aplicar una segunda vez para confirmar que es idempotente.
#   6. Corre un puñado de verificaciones de sanidad (tablas, RLS, trigger de
#      dependencia, trigger de categoría especial).
#
# Uso:
#   ./scripts/validate-promociones-schema.sh /ruta/a/prod_schema.sql
#
# Requisitos: Docker corriendo, Supabase CLI instalado, estar en la raíz del
# repo. No hace falta psql local -- se usa `docker exec` contra el
# contenedor que levanta `supabase start`.

set -euo pipefail

SCHEMA_FILE="${1:-}"
if [[ -z "$SCHEMA_FILE" ]]; then
  echo "Uso: $0 /ruta/a/prod_schema.sql" >&2
  exit 1
fi
if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "No existe el archivo: $SCHEMA_FILE" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MIGRATIONS_DIR="supabase/migrations"
HOLDOUT_DIR="$(mktemp -d)"
FEATURE_MIGRATION="20261104120000_promociones_meta_schema.sql"

# RESTORED evita que el trap restaure dos veces -- si el flujo principal ya
# movió los archivos reales de vuelta a MIGRATIONS_DIR (ver más abajo), el
# trap NO debe volver a vaciarlo y repoblarlo desde HOLDOUT_DIR (que para
# entonces ya está vacío) o se queda sin archivos. Bug real encontrado
# corriendo este script la primera vez -- confirmado con `git status`.
RESTORED=0
cleanup() {
  if [[ "$RESTORED" -eq 0 ]]; then
    echo "-- Restaurando supabase/migrations/ a su estado real (el flujo principal no llegó a hacerlo) --"
    rm -rf "${MIGRATIONS_DIR:?}"/*
    if [[ -d "$HOLDOUT_DIR/migrations" ]]; then
      mv "$HOLDOUT_DIR"/migrations/* "$MIGRATIONS_DIR"/ 2>/dev/null || true
    fi
  fi
  rm -rf "$HOLDOUT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if [[ ! -f "$MIGRATIONS_DIR/$FEATURE_MIGRATION" ]]; then
  echo "No se encontró $MIGRATIONS_DIR/$FEATURE_MIGRATION -- ¿corriste esto desde la raíz del repo, en la rama correcta?" >&2
  exit 1
fi

echo "-- Vaciando temporalmente $MIGRATIONS_DIR para un Postgres base limpio --"
mkdir -p "$HOLDOUT_DIR/migrations"
mv "$MIGRATIONS_DIR"/* "$HOLDOUT_DIR/migrations/"

echo "-- Asegurando una base de datos local completamente limpia (sin restaurar de un backup/corrida anterior) --"
supabase stop --no-backup 2>/dev/null || true

echo "-- supabase start (plataforma base: auth/storage/extensiones reales, sin migraciones de este repo) --"
supabase start

DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep supabase_db_ | head -1)"
if [[ -z "$DB_CONTAINER" ]]; then
  echo "No se encontró el contenedor de Postgres local tras supabase start." >&2
  exit 1
fi
PSQL=(docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

echo "-- Restaurando supabase/migrations/ (ya no se necesita vacío) --"
mv "$HOLDOUT_DIR"/migrations/* "$MIGRATIONS_DIR"/
RESTORED=1

echo "-- Aplicando el volcado de esquema real de producción --"
"${PSQL[@]}" < "$SCHEMA_FILE"

echo "-- Aplicando la migración de Promocionar publicaciones (1a vez) --"
"${PSQL[@]}" < "$MIGRATIONS_DIR/$FEATURE_MIGRATION"

echo "-- Aplicando la misma migración otra vez (prueba de idempotencia) --"
if "${PSQL[@]}" < "$MIGRATIONS_DIR/$FEATURE_MIGRATION" > /tmp/validate-promociones-2nd-run.log 2>&1; then
  echo "   OK -- la migración corrió dos veces sin error."
else
  echo "   FALLÓ en la segunda corrida -- no es idempotente contra este esquema real. Ver /tmp/validate-promociones-2nd-run.log" >&2
  cat /tmp/validate-promociones-2nd-run.log >&2
  exit 1
fi

echo "-- Verificaciones de sanidad --"
CHECKS_SQL=$(cat <<'SQL'
\pset tuples_only on
select 'tabla social_ad_connections existe: ' || (to_regclass('public.social_ad_connections') is not null);
select 'tabla social_promotions existe: ' || (to_regclass('public.social_promotions') is not null);
select 'tabla social_promotion_metrics existe: ' || (to_regclass('public.social_promotion_metrics') is not null);
select 'tabla social_promotion_audit existe: ' || (to_regclass('public.social_promotion_audit') is not null);
select 'RLS activo en social_promotions: ' || relrowsecurity from pg_class where oid = 'public.social_promotions'::regclass;
select 'trigger de categoría especial existe: ' || exists(
  select 1 from pg_trigger where tgname = 'trg_validate_special_ad_category'
);
select 'trigger de dependencia de módulo existe: ' || exists(
  select 1 from pg_trigger where tgname = 'trg_promocion_publicaciones_dependency'
);
select 'module_key promocion_publicaciones permitido: ' || exists(
  select 1 from pg_constraint where conname = 'business_modules_module_key_check'
  and pg_get_constraintdef(oid) like '%promocion_publicaciones%'
);
SQL
)
"${PSQL[@]}" <<< "$CHECKS_SQL"

echo ""
echo "===================================================================="
echo "Listo. Revisa arriba que las 8 verificaciones digan todas 't' (true)."
echo "Esto NO corrió pruebas de RLS entre dos organizaciones reales (para"
echo "eso, crea datos de prueba con dos orgs como en la ronda anterior --"
echo "ver docs/promociones-meta.md §7) ni desplegó nada. supabase stop para"
echo "apagar los contenedores cuando termines."
echo "===================================================================="
