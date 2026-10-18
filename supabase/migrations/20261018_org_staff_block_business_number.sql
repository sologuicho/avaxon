-- org_staff.phone debe ser el número personal de una persona del staff, no
-- el número de negocio de WhatsApp de la plataforma (registrado en
-- phone_numbers.display_phone_number). Si un número de negocio queda con
-- active=true y receives_inventory_check=true (como pasó con el número de
-- Home Food, que es también el contacto de prueba del bot de ventas de
-- Avaxon), cualquier mensaje de prueba al bot de ventas se enruta por error
-- al flujo de Cocina. Este trigger lo bloquea con un error claro.

create or replace function org_staff_block_business_number()
returns trigger
language plpgsql
as $$
declare
  normalized_phone text := regexp_replace(new.phone, '\D', '', 'g');
  match_count int;
begin
  if new.active = true or new.receives_inventory_check = true then
    select count(*) into match_count
    from phone_numbers
    where regexp_replace(display_phone_number, '\D', '', 'g') = normalized_phone;

    if match_count > 0 then
      raise exception
        'org_staff.phone % es un número de negocio de WhatsApp registrado en phone_numbers (no es el número personal de una persona) -- no puede quedar con active=true ni receives_inventory_check=true',
        new.phone;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_org_staff_block_business_number on org_staff;

create trigger trg_org_staff_block_business_number
before insert or update on org_staff
for each row
execute function org_staff_block_business_number();
