// Synthetic data only. Field names/types match the real API (probe 2026-09-23); values are invented.
export const NOW = new Date("2026-09-23T12:00:00-03:00");

export function vacancyRaw(o: Record<string, unknown> = {}) {
  return {
    id: "6a0000000000000000000001",
    nombre: "Soldador calificado - Añelo",
    fechaCreacion: "01-08-2026",
    fechaCierre: null,
    estadoActual: "Activa",
    ubicacion: { pais: "Argentina", provincia: "Neuquén", ciudad: "Añelo" },
    refId: null,
    creadaPor: { id: "u1", nombre: "Ana", apellido: "Paz" },
    salarioOfrecido: "0",
    razonBusqueda: 1,
    requisitos: "Experiencia en soldadura MIG/TIG.",
    areaTrabajo: "Producción",
    subareaTrabajo: "Mantenimiento",
    tipoTrabajo: "Full-time",
    modalidadTrabajo: "Presencial",
    jerarquia: "Junior",
    nivelMinimoEducacion: "Secundario",
    descripcionTrabajo: "Soldadura en planta de tratamiento.",
    posicionesACubrir: 3,
    prioridad: "Media",
    remuneracion: 0,
    currency: "ARS",
    publicada: "Si",
    pipelineId: "p2",
    usuarios: [{ id: "u1", nombre: "Ana", apellido: "Paz" }, { id: "u2", nombre: "Leo", apellido: "Sur" }],
    client: { id: "c1", compañia: "Operadora Sur", descripcion: "Empresa de servicios petroleros." },
    micrositios: [],
    ...o,
  };
}

export function postulantRaw(o: Record<string, unknown> = {}) {
  return {
    id: "6b0000000000000000000001",
    nombre: "Juan",
    apellido: "Pérez",
    email: "juan.perez@example.com",
    anonimo: null,
    fechaNacimiento: "01-01-1990",
    telefonoFijo: "+5429900000",
    telefonoCelular: "+5429911111",
    dni: "30000000",
    cuil: null,
    genero: "Masculino",
    fotoPerfil: "https://example.com/foto.jpg",
    presentacionPostulante: "Soldador con experiencia en yacimientos.",
    redesSociales: { linkedin: null, facebook: null, twitter: null, website: null },
    direccion: { pais: "Argentina", provincia: "Neuquén", ciudad: "Añelo", direccion: "Calle Falsa 123", paisId: 1, provinciaId: 2, ciudadId: 3 },
    nacionalidad: "Argentina",
    etapa: "Nuevo",
    experienciasLaborales: [
      { empresa: "Metalúrgica Sur", puesto: "Soldador MIG", mesDesde: 1, añoDesde: 2018, mesHasta: 12, añoHasta: 2021, trabajoActual: false, pais: "Argentina", area: "Producción", subArea: "Soldadura", industria: "Metal", seniority: "Semi-senior", descripcion: "Soldadura de cañerías." },
      { empresa: "Servicios Petroleros", puesto: "Soldador calificado", mesDesde: 6, añoDesde: 2021, mesHasta: null, añoHasta: null, trabajoActual: true, pais: "Argentina", area: "Oil & Gas", subArea: "Mantenimiento", industria: "Petróleo", seniority: "Senior", descripcion: "Mantenimiento de ductos." },
    ],
    estudios: [
      { institucion: "EPET 8", titulo: "Técnico mecánico", mesDesde: 3, añoDesde: 2004, mesHasta: 12, añoHasta: 2009, estudioActual: false, pais: "Argentina", area: "Técnica", nivel: "Secundario", estado: "Graduado", descripcion: null },
    ],
    fechaPostulacion: "20-09-2026",
    fuente: "Web",
    salarioPretendido: null,
    vacanteId: "6a0000000000000000000001",
    vacanteNombre: "Soldador calificado - Añelo",
    rechazado: "No",
    tags: [{ nombre: "Disponible ya", creadoPor: "Ana Paz", fechaCreacion: "21-09-2026" }],
    micrositio: null,
    ...o,
  };
}

export function pipelinesRaw() {
  return [
    { id: "p1", nombre: "Default", descripcion: "x", estado: 1, etapas: [{ id: 0, nombre: "NUEVO" }, { id: 1, nombre: "EN REVISIÓN" }, { id: 2, nombre: "ENTREVISTA" }, { id: 4, nombre: "CONTRATADO" }, { id: 7, nombre: "---" }] },
    { id: "p2", nombre: "Pipeline vigente", descripcion: "y", estado: 1, etapas: [{ id: 0, nombre: "NUEVO" }, { id: 1, nombre: "EN REVISIÓN" }, { id: 2, nombre: "ENTREVISTA" }, { id: 4, nombre: "CONTRATADO" }, { id: 7, nombre: "PRESENTADO" }] },
  ];
}
