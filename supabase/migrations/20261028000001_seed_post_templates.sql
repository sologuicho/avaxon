-- Seed inicial de post_templates: 2–3 plantillas por cada giro
-- que aparece en la landing de Avaxon (sección Industrias).
-- Estas son plantillas de catálogo global (sin organization_id).
-- {{nombre_negocio}}, {{teléfono}}, {{ciudad}} son variables que
-- el frontend reemplaza al generar el borrador de publicación.

INSERT INTO public.post_templates
  (giro, name, format, platforms, preview_kicker, preview_headline, preview_subtext, caption_template, media_urls, is_active)
VALUES

-- ── Clínicas y consultorios ───────────────────────────────────────────────────
(
  'Clínicas y consultorios',
  'Chequeo anual: el hábito más barato',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🏥 Salud preventiva',
  'Un chequeo al año puede salvarte la vida',
  'Detectar a tiempo es siempre la mejor medicina',
  E'Un chequeo médico anual puede detectar lo que tú todavía no sientes.\n\n✅ Análisis de sangre completo\n✅ Presión arterial y glucosa\n✅ Evaluación personalizada con tu médico\n\nAgenda el tuyo hoy directo por WhatsApp 👇\n📲 {{teléfono}}\n\n#Salud #MedicinaPreventiva #{{ciudad}} #{{nombre_negocio}}',
  '[]',
  true
),
(
  'Clínicas y consultorios',
  '5 síntomas que no debes ignorar',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🚨 Señales de alerta',
  '5 síntomas que nunca debes ignorar',
  'Tu cuerpo te habla — aprende a escucharlo',
  E'¿Tu cuerpo te está mandando señales? 👂\n\nDesliza y descubre 5 síntomas que merecen atención médica cuanto antes.\n\nSi tienes dudas, estamos aquí para orientarte sin costo.\n📲 Escríbenos al {{teléfono}}\n\n#Salud #{{nombre_negocio}} #{{ciudad}} #MedicinaGeneral',
  '[]',
  true
),
(
  'Clínicas y consultorios',
  'Presentación del equipo médico',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '👨‍⚕️ Nuestro equipo',
  'Conoce a los médicos que te cuidan',
  'Experiencia, calidez y compromiso con tu salud',
  E'En {{nombre_negocio}} atendemos a cada paciente con el tiempo y la atención que merece.\n\n🩺 Médicos certificados\n🕐 Citas en menos de 24 h\n📍 {{ciudad}}\n\n¿Tienes algún malestar? No lo dejes para después.\nAgenda por WhatsApp 📲 {{teléfono}}\n\n#Médicos #{{ciudad}} #{{nombre_negocio}} #AtenciónMédica',
  '[]',
  true
),

-- ── Odontología ───────────────────────────────────────────────────────────────
(
  'Odontología',
  'Tu sonrisa merece lo mejor',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '😁 Sonrisa perfecta',
  'Una sonrisa sana es tu mejor carta de presentación',
  'Limpieza, blanqueamiento y más desde ${{precio}}',
  E'¿Cuándo fue tu última visita al dentista? 🦷\n\nEn {{nombre_negocio}} te cuidamos desde la limpieza hasta el implante.\n\n✨ Blanqueamiento dental\n🦷 Ortodoncia e implantes\n🪥 Limpieza profunda\n\nPrimera consulta de valoración SIN COSTO.\n📲 Agenda por WhatsApp: {{teléfono}}\n\n#Dentista #Odontología #{{ciudad}} #{{nombre_negocio}}',
  '[]',
  true
),
(
  'Odontología',
  'Cuándo cambiar el cepillo dental',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🪥 Tip dental',
  '¿Cada cuánto cambias tu cepillo?',
  'La respuesta te puede sorprender',
  E'Dato que muchos ignoran: tu cepillo debe cambiarse cada 3 meses 🪥\n\nDesliza y descubre más tips que cuidan tu sonrisa desde casa.\n\n¿Tienes dudas sobre tu higiene bucal? Escríbenos, con gusto te orientamos.\n📲 {{teléfono}}\n\n#Odontología #TipDental #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
),

-- ── Talleres mecánicos ────────────────────────────────────────────────────────
(
  'Talleres mecánicos',
  'Mantenimiento preventivo: evita el gasto mayor',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🔧 Mecánica preventiva',
  'Un cambio de aceite a tiempo te ahorra miles',
  'No esperes a que tu carro te dé el susto',
  E'¿Cuándo fue el último servicio de tu carro? 🚗\n\nEl mantenimiento preventivo es la inversión más inteligente que puedes hacer en tu vehículo.\n\n🔧 Cambio de aceite y filtros\n🛞 Rotación de llantas\n⚡ Revisión eléctrica y de frenos\n\n📍 {{ciudad}} | 📲 {{teléfono}}\nCotiza por WhatsApp en minutos.\n\n#Mecánica #{{ciudad}} #MantenimientoAutomotriz #{{nombre_negocio}}',
  '[]',
  true
),
(
  'Talleres mecánicos',
  '5 señales de que tu carro necesita atención',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🚨 Señales de alerta',
  '5 señales que tu carro te manda y tú ignoras',
  'No esperes al taller de emergencia',
  E'Tu carro te habla antes de tronar 🚗💬\n\nDesliza y aprende a identificar las 5 señales más comunes de que necesita revisión.\n\n¿Ya notaste alguna? Escríbenos y te damos una cotización sin costo.\n📲 {{teléfono}}\n\n#Mecánica #{{nombre_negocio}} #{{ciudad}} #CarroSano',
  '[]',
  true
),

-- ── Inmobiliarias ─────────────────────────────────────────────────────────────
(
  'Inmobiliarias',
  'Propiedad destacada de la semana',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🏡 Propiedad destacada',
  'Tu próximo hogar te está esperando',
  'Financiamiento disponible — te asesoramos sin costo',
  E'🏡 Propiedad de la semana\n\n📍 {{colonia}}, {{ciudad}}\n🛏 {{recámaras}} recámaras | 🚿 {{baños}} baños\n📐 {{m2}} m²\n💰 {{precio}}\n\n¿Te interesa? Escríbenos por WhatsApp y agendamos tu visita.\n📲 {{teléfono}}\n\n#Inmuebles #CasaEnVenta #{{ciudad}} #{{nombre_negocio}}',
  '[]',
  true
),
(
  'Inmobiliarias',
  'Guía para comprar tu primera casa',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🔑 Primera casa',
  'Comprar tu primera casa no tiene que ser complicado',
  'Te guiamos paso a paso hasta las llaves en mano',
  E'¿Primera vez comprando casa? 🏠\n\nDesliza y conoce los pasos que nadie te cuenta antes de firmar.\n\nEn {{nombre_negocio}} te acompañamos desde la búsqueda hasta la escritura.\n📲 Asesoría sin costo: {{teléfono}}\n\n#PrimeraCasa #BienesRaíces #{{ciudad}} #{{nombre_negocio}}',
  '[]',
  true
),

-- ── Escuelas y cursos ─────────────────────────────────────────────────────────
(
  'Escuelas y cursos',
  'Inscripciones abiertas',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🎓 Inscripciones',
  'Ya están abiertas las inscripciones',
  'Cupo limitado — asegura tu lugar hoy',
  E'¡Las inscripciones para {{periodo}} ya están abiertas! 🎓\n\n📚 {{nombre_curso_o_programa}}\n📅 Inicio: {{fecha_inicio}}\n⏰ Horarios: {{horarios}}\n💰 Inversión: {{precio}}\n\nCupo limitado. Aparta tu lugar por WhatsApp.\n📲 {{teléfono}}\n\n#Educación #{{ciudad}} #{{nombre_negocio}} #Cursos',
  '[]',
  true
),
(
  'Escuelas y cursos',
  '¿Por qué estudiar con nosotros?',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '⭐ Por qué elegirnos',
  '5 razones para estudiar en {{nombre_negocio}}',
  'Más de {{años}} años formando profesionales',
  E'No todas las escuelas son iguales 🎓\n\nDesliza y descubre por qué nuestros alumnos eligen quedarse y nos recomiendan.\n\n¿Tienes dudas sobre el programa o los requisitos? Escríbenos.\n📲 {{teléfono}}\n\n#Educación #{{nombre_negocio}} #{{ciudad}} #FormaciónProfesional',
  '[]',
  true
),

-- ── Salones y spas ────────────────────────────────────────────────────────────
(
  'Salones y spas',
  'Servicio del mes con promoción',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '💆 Oferta del mes',
  'Este mes: {{servicio}} con descuento especial',
  'Solo hasta el {{fecha_fin}} — agenda ya',
  E'✨ Oferta del mes en {{nombre_negocio}}\n\n{{servicio}} por solo ${{precio_promo}} (precio regular ${{precio_normal}})\n\n📅 Disponible hasta el {{fecha_fin}}\n📍 {{dirección}}, {{ciudad}}\n\nAgenda tu cita por WhatsApp y elige tu horario.\n📲 {{teléfono}}\n\n#Belleza #{{ciudad}} #{{nombre_negocio}} #SpaDay',
  '[]',
  true
),
(
  'Salones y spas',
  'Transforma tu look: antes y después',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '✂️ Transformación',
  'El look que querías, hecho realidad',
  'Confía en nuestras manos — los resultados hablan',
  E'La mejor versión de ti empieza con un buen corte ✂️\n\nDesliza y mira algunas de las transformaciones que hemos logrado para nuestras clientas.\n\n¿Lista para tu cambio? Agenda tu cita en minutos.\n📲 {{teléfono}}\n\n#Estilismo #{{nombre_negocio}} #{{ciudad}} #Belleza #HairTransformation',
  '[]',
  true
),

-- ── Servicios a domicilio ─────────────────────────────────────────────────────
(
  'Servicios a domicilio',
  'Cotiza en minutos por WhatsApp',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🏠 A domicilio',
  'Sin colas, sin traslados — llegamos a tu casa',
  'Cotiza gratis por WhatsApp en menos de 5 min',
  E'¿Necesitas {{tipo_servicio}} y no tienes tiempo de salir? 🏠\n\nNosotros vamos a donde estás.\n\n⚡ Respuesta en menos de 1 hora\n✅ Presupuesto sin compromiso\n🔐 Personal verificado y con garantía\n\nEscríbenos ahorita y cotizamos sin costo.\n📲 {{teléfono}}\n\n#ServiciosADomicilio #{{ciudad}} #{{nombre_negocio}}',
  '[]',
  true
),
(
  'Servicios a domicilio',
  'Lista de servicios que ofrecemos',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '📋 Nuestros servicios',
  'Todo lo que podemos hacer por ti sin que salgas de casa',
  'Rápido, garantizado y al mejor precio',
  E'¿Sabías que ofrecemos {{número_servicios}} servicios a domicilio en {{ciudad}}? 🏠\n\nDesliza y descubre todo lo que podemos resolver en tu hogar o negocio.\n\n¿No ves lo que necesitas? Igual consúltanos — seguro podemos ayudarte.\n📲 {{teléfono}}\n\n#ServiciosADomicilio #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
),

-- ── Restaurantes y fondas ─────────────────────────────────────────────────────
(
  'Restaurantes y fondas',
  'Platillo del día',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🍽️ Menú del día',
  'Hoy en {{nombre_negocio}}: {{platillo}}',
  'Pide por WhatsApp y lo tenemos listo',
  E'🍽️ Hoy tenemos {{platillo}} y está delicioso.\n\n💰 Solo ${{precio}} | 📦 Con entrega a domicilio\n⏰ Disponible de {{hora_inicio}} a {{hora_fin}} hrs\n\n¿Se te antojó? Haz tu pedido por WhatsApp y lo preparamos al momento.\n📲 {{teléfono}}\n\n#Comida #{{ciudad}} #{{nombre_negocio}} #FoodLovers',
  '[]',
  true
),
(
  'Restaurantes y fondas',
  'Menú de la semana',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '📅 Menú semanal',
  'El menú de esta semana ya está listo',
  'Come rico, come casero — nosotros cocinamos',
  E'Ya tenemos el menú de la semana 🍲\n\nDesliza y checa qué hay cada día.\n\n📦 Pedidos a domicilio y para llevar\n📲 Ordena por WhatsApp: {{teléfono}}\n📍 {{dirección}}, {{ciudad}}\n\n#Comida #MenuSemanal #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
),

-- ── Gimnasios y fitness ───────────────────────────────────────────────────────
(
  'Gimnasios y fitness',
  'Inicia tu cambio hoy — clase gratis',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '💪 Fitness',
  'Tu primer clase es gratis',
  'Sin excusas — el cambio empieza con un paso',
  E'El mejor momento para empezar fue ayer. El segundo mejor momento es HOY 💪\n\nEn {{nombre_negocio}} te regalamos tu primera clase.\n\n🏋️ Pesas y cardio\n🧘 Clases grupales\n👟 Entrenadores certificados\n📍 {{dirección}}, {{ciudad}}\n\nAparta tu clase gratuita por WhatsApp.\n📲 {{teléfono}}\n\n#Fitness #Gimnasio #{{ciudad}} #{{nombre_negocio}} #Ejercicio',
  '[]',
  true
),
(
  'Gimnasios y fitness',
  'Rutina de la semana',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🏋️ Rutina semanal',
  'La rutina de esta semana para que no tengas pretextos',
  'Entrena en casa o en el gym — tú decides',
  E'¿Ya tienes plan de entrenamiento para esta semana? 🏋️\n\nDesliza y llévate la rutina que prepararon nuestros coaches.\n\n¿Quieres resultados más rápidos con un plan personalizado? Escríbenos.\n📲 {{teléfono}}\n\n#Fitness #Rutina #{{nombre_negocio}} #{{ciudad}} #Entrenamiento',
  '[]',
  true
),

-- ── Veterinarias ──────────────────────────────────────────────────────────────
(
  'Veterinarias',
  'Tip de salud para tu mascota',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🐾 Salud animal',
  'Tu mascota también necesita su chequeo anual',
  'Detección temprana = vida larga y feliz',
  E'¿Sabías que un chequeo veterinario al año puede detectar enfermedades antes de que sean graves? 🐾\n\nEn {{nombre_negocio}} cuidamos a tu peludo como si fuera el nuestro.\n\n🐶 Consulta general\n💉 Vacunación y desparasitación\n✂️ Estética canina y felina\n\nAgenda por WhatsApp.\n📲 {{teléfono}} | 📍 {{ciudad}}\n\n#Veterinaria #Mascotas #{{ciudad}} #{{nombre_negocio}} #AmanteDeLosAnimales',
  '[]',
  true
),
(
  'Veterinarias',
  'Calendario de vacunación',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '💉 Vacunas',
  '¿Tu mascota está al día con sus vacunas?',
  'El calendario que todo dueño debería tener',
  E'Las vacunas de tu mascota no son opcionales 🐕💉\n\nDesliza y descubre el calendario completo para perros y gatos.\n\n¿Tienes dudas o necesitas agendar? Escríbenos cuando quieras.\n📲 {{teléfono}}\n\n#Veterinaria #Vacunas #{{nombre_negocio}} #{{ciudad}} #Mascotas',
  '[]',
  true
),

-- ── Abogados y despachos ──────────────────────────────────────────────────────
(
  'Abogados y despachos',
  'Tip legal de la semana',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '⚖️ Tip legal',
  'Lo que la ley dice y casi nadie sabe',
  'Conocer tus derechos es el primer paso',
  E'⚖️ Tip legal de la semana:\n\n{{tip_legal}}\n\nIgnorar tus derechos puede salirte caro. Si tienes alguna situación legal que resolver, en {{nombre_negocio}} te damos una primera consulta orientativa sin costo.\n\n📲 Escríbenos: {{teléfono}}\n📍 {{ciudad}}\n\n#Derecho #TipLegal #{{nombre_negocio}} #{{ciudad}} #Abogados',
  '[]',
  true
),
(
  'Abogados y despachos',
  'Cuándo necesitas un abogado',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🤔 ¿Necesitas abogado?',
  '6 situaciones en las que sí necesitas un abogado',
  'No esperes a que el problema sea más grande',
  E'Muchas personas buscan un abogado cuando ya es demasiado tarde ⚖️\n\nDesliza y descubre 6 situaciones en las que conviene actuar a tiempo.\n\n¿Estás en alguna de estas? Cuéntanos tu caso — primera consulta sin costo.\n📲 {{teléfono}}\n\n#Abogados #Derecho #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
),

-- ── Agencias de viajes ────────────────────────────────────────────────────────
(
  'Agencias de viajes',
  'Destino del mes',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '✈️ Destino del mes',
  'Este mes nos vamos a {{destino}}',
  'Paquete completo desde ${{precio}} por persona',
  E'✈️ Destino del mes: {{destino}}\n\n🌍 {{descripción_destino}}\n\n📦 El paquete incluye:\n✅ Vuelos redondos\n✅ Hotel {{estrellas}} estrellas\n✅ {{noches}} noches\n✅ {{incluye_extras}}\n\n💰 Desde ${{precio}} por persona\n\n¡Los lugares se van rápido! Aparta el tuyo hoy.\n📲 {{teléfono}}\n\n#Viajes #{{destino}} #{{nombre_negocio}} #{{ciudad}} #TravelLovers',
  '[]',
  true
),
(
  'Agencias de viajes',
  'Qué incluye tu paquete de viaje',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🧳 Tu paquete',
  'Todo lo que incluye tu próximo viaje con nosotros',
  'Tú solo disfruta — nosotros nos encargamos de todo',
  E'¿Te preguntas qué se siente viajar sin preocupaciones? 🧳\n\nDesliza y descubre todo lo que incluye un paquete completo con {{nombre_negocio}}.\n\n¿Tienes una fecha o destino en mente? Escríbenos y te cotizamos hoy.\n📲 {{teléfono}}\n\n#Viajes #Paquetes #{{nombre_negocio}} #{{ciudad}} #Turismo',
  '[]',
  true
),

-- ── Tiendas y comercios ───────────────────────────────────────────────────────
(
  'Tiendas y comercios',
  'Producto destacado de la semana',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🛍️ Producto estrella',
  '{{producto}}: el favorito de esta semana',
  'Stock limitado — pide el tuyo antes de que se agote',
  E'🛍️ Producto de la semana:\n\n{{producto}}\n💰 Precio: ${{precio}}\n{{descripción_corta}}\n\n📦 Envío a domicilio disponible\n🏪 También en tienda: {{dirección}}\n\n¿Lo quieres? Escríbenos por WhatsApp y te lo apartamos.\n📲 {{teléfono}}\n\n#Tienda #{{nombre_negocio}} #{{ciudad}} #Compras',
  '[]',
  true
),
(
  'Tiendas y comercios',
  'Novedades de la semana',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🆕 Novedades',
  'Mira lo que llegó esta semana',
  'Productos nuevos que no te puedes perder',
  E'¡Llegaron cosas nuevas a {{nombre_negocio}}! 🆕\n\nDesliza y mira las novedades de esta semana.\n\n📦 Enviamos a todo {{ciudad}} y zonas cercanas\n📲 Haz tu pedido por WhatsApp: {{teléfono}}\n\n#Novedades #{{nombre_negocio}} #{{ciudad}} #Shopping',
  '[]',
  true
),

-- ── Psicólogos y terapeutas ───────────────────────────────────────────────────
(
  'Psicólogos y terapeutas',
  'Tip de bienestar mental',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🧠 Bienestar mental',
  'Tu mente también necesita atención',
  'Un pequeño hábito diario puede cambiar mucho',
  E'🧠 Tip de bienestar mental de esta semana:\n\n{{tip_bienestar}}\n\nCuidar tu salud mental no es un lujo, es una necesidad. Si sientes que necesitas apoyo, estoy aquí para acompañarte.\n\n📲 Primera sesión de orientación sin costo: {{teléfono}}\n📍 {{ciudad}} | Consulta presencial y en línea\n\n#SaludMental #Psicología #{{nombre_negocio}} #{{ciudad}} #Bienestar',
  '[]',
  true
),
(
  'Psicólogos y terapeutas',
  'Señales de que podrías necesitar apoyo',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🔍 ¿Cómo me siento?',
  'Señales de que es buen momento para pedir ayuda',
  'Reconocerlas es el primer paso',
  E'Pedir ayuda no es debilidad — es valentía 💙\n\nDesliza y conoce algunas señales que indican que hablar con un profesional podría beneficiarte.\n\nSi te identificas con alguna, escríbeme con confianza.\n📲 {{teléfono}} | Primera sesión orientativa sin costo\n\n#SaludMental #Terapia #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
),

-- ── Seguros y finanzas ────────────────────────────────────────────────────────
(
  'Seguros y finanzas',
  'Tip de protección financiera',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '💰 Finanzas personales',
  '¿Estás protegido si mañana pasa algo?',
  'Un seguro no es un gasto — es una red de seguridad',
  E'💰 Dato que muchos ignoran:\n\nEl {{porcentaje}}% de las familias mexicanas no tiene ningún tipo de seguro de vida o gastos médicos.\n\nUn imprevisto no avisado puede comprometer años de esfuerzo.\n\nEn {{nombre_negocio}} te ayudamos a encontrar la protección correcta para tu presupuesto.\n\n📲 Cotiza sin compromiso: {{teléfono}}\n📍 {{ciudad}}\n\n#Seguros #FinanzasPersonales #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
),
(
  'Seguros y finanzas',
  '¿Qué cubre tu seguro realmente?',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '📋 Tu seguro',
  'Lo que tu seguro cubre y lo que no te dicen',
  'Lee la letra pequeña antes de que la necesites',
  E'¿Realmente sabes qué cubre tu seguro? 🤔\n\nDesliza y descubre las coberturas más importantes que debes revisar en tu póliza.\n\n¿Tienes dudas sobre la tuya? Platiquemos — sin costo y sin compromiso.\n📲 {{teléfono}}\n\n#Seguros #{{nombre_negocio}} #{{ciudad}} #FinanzasPersonales',
  '[]',
  true
),

-- ── Estética automotriz ───────────────────────────────────────────────────────
(
  'Estética automotriz',
  'Transformación: antes y después',
  'post',
  ARRAY['facebook_page','instagram_business'],
  '🚗 Detailing',
  'Tu carro nuevo sin comprarlo nuevo',
  'Mira la diferencia que hace un detailing profesional',
  E'🚗 Antes y después — el resultado habla solo.\n\nEn {{nombre_negocio}} le devolvemos a tu carro el brillo que tenía el primer día.\n\n✨ Lavado detallado interior y exterior\n🪣 Encerado y protección de pintura\n🧴 Restauración de plásticos y cristales\n\n📍 {{dirección}}, {{ciudad}}\n📲 Cotiza por WhatsApp: {{teléfono}}\n\n#Detailing #EstéticaAutomotriz #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
),
(
  'Estética automotriz',
  'Servicios que ofrecemos',
  'carrusel',
  ARRAY['facebook_page','instagram_business'],
  '🧽 Nuestros servicios',
  'Todo lo que hacemos por tu carro en un solo lugar',
  'Desde lavado express hasta detailing completo',
  E'¿Sabes todos los servicios que tenemos para tu carro? 🚗✨\n\nDesliza y descubre desde el lavado express hasta el detailing completo.\n\n¿Quieres agendar? Escríbenos y te decimos la disponibilidad del día.\n📲 {{teléfono}} | 📍 {{ciudad}}\n\n#EstéticaAutomotriz #Detailing #{{nombre_negocio}} #{{ciudad}}',
  '[]',
  true
);
