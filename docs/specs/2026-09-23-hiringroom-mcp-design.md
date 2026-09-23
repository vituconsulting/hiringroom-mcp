# HiringRoom MCP — design (MVP)

- Date: 2026-09-23
- Client: Patagonia Resources
- Status: approved design, pending implementation plan

## 1. Goal

Let Claude (via Claude Code) query Patagonia Resources' HiringRoom account: find
postulants, check the status of searches (vacancies), pull hiring/movement
reports and run a scoped cross-search of candidates by profile, including the
text of attached CVs.

### In scope (MVP)

- Local stdio MCP server for Claude Code, operated by Vitu only.
- Read-only access to HiringRoom API v0 (`https://api.hiringroom.com/v0`).
- 10 task-oriented tools with Spanish names and descriptions.
- Server-side shaping of payloads, pagination, date formats and date windows.
- Live, scoped cross-search (no local index).
- CV text extraction (PDF, DOCX).
- Local audit log without personal data.

### Out of scope (MVP)

- Any write to HiringRoom (create/publish vacancies, hire, reject, comment,
  upload files, feedback to shortlisted candidates).
- Remote HTTP transport, OAuth, Claude.ai custom connector, VPS deploy.
- Use by Patagonia recruiters directly.
- Local index / full-base search.
- Multi-tenant logic.

The core modules (`hr/`, `shape/`, `search/`, `cv/`, `tools/`) must not depend
on the transport, so a later remote connector only adds an HTTP entry point and
an auth layer.

## 2. API facts (from the 2026-09-23 read-only probe)

| Fact | Consequence |
|---|---|
| `client_credentials` returns `401 invalid_client` with the given credentials | Auth uses the password flow with a service user: `POST /authenticate/login/users` with `grand_type: "password"` (sic), `client_id`, `client_secret`, `username`, `password` |
| Login returns `token`, `expiresIn` (~86400 s), `tokenType`, `refreshToken` | Keep token in memory; refresh before expiry via `/authenticate/login/refresh_token`; re-login on `401` |
| Token is sent as `token` header (spec also lists it as query param) | Always use the header; never put it in URLs |
| Requests need a `User-Agent` | Send `hiringroom-mcp/<version>` |
| `pageSize` must be 10–100; first page is 0 | Hidden from Claude; tools expose `pagina` starting at 1 and `limite` |
| List filters take epoch seconds (`createdFrom/To`); report endpoints take `DD-MM-YYYY` | Tools take ISO `YYYY-MM-DD`; `hr/dates.ts` converts |
| `/postulants/hired/` max range 30 days; `/vacancies/byChangedStatus` max 7 days; `/postulants/byDay/` one day per call | Server splits ranges into windows |
| `/vacancies/{id}/stats` took 4 s once and timed out at 60 s once | Opt-in, own 10 s budget |
| `/account/stages` returns 404 | Stages come from `/pipeline/` (pipelines with `etapas[{id,nombre}]`) |
| 564 vacancies, ~43,900 postulants; 100 postulants per page ≈ 1 s, ~260 KB | Full-base live scan is not viable; cross-search must be scoped |
| `/postulants/` list already includes `experienciasLaborales`, `estudios`, `direccion`, `tags`, `presentacionPostulante` | Cross-search scores on list data; full profile only when needed |
| Full profile (`/postulants/{id}`) adds `comentarios`, `conocimientos`, `referencias`, `disponibilidad*`, `adjuntos`, `reportes`, `legajo` | Exposed by `ver_postulante` |
| `/postulants/{id}/files` → `archivos[{fileId, description}]`; `/postulants/{id}/file/{fileId}` returns the binary (sample: `application/pdf`, ~150 KB, text layer present) | `leer_cv` downloads and extracts text |
| 30 parallel requests: all 200, no rate-limit headers | Concurrency cap of 5 is conservative; still handle `429` |
| `/vacancies/{id}/report/ternados` returns `422 "There are no reports in this vacancy"` when empty | Treat as empty result, not an error |
| `/vacancies/{id}/notes` returns `202 {result}` | Handle non-200 success codes |

## 3. Architecture

```
Claude Code ──stdio──► hiringroom-mcp (node dist/index.js)
                         ├─ config.ts     secrets file + limits
                         ├─ hr/           HiringRoom client (GET-only + login)
                         ├─ shape/        payload → summaries, sensitive filter, size trim
                         ├─ search/       cross-search normalization + scoring
                         ├─ cv/           PDF/DOCX → text
                         ├─ tools/        one file per tool
                         └─ audit.ts      JSONL audit log
```

### 3.1 Configuration and secrets

- Secrets file path: env `HIRINGROOM_ENV_FILE`, default `~/.config/hiringroom-mcp/.env`.
- Required keys: `HR_CLIENT_ID`, `HR_CLIENT_SECRET`, `HR_USERNAME`, `HR_PASSWORD`.
- Startup refuses to run (exit with a clear stderr message naming the problem, never the values) if:
  - the file is missing or readable by group/others (mode must be 600);
  - any required key is missing or empty;
  - `pdftotext` is not on `PATH`.
- Limits (section 6) have defaults in `config.ts`, overridable by env.
- Repo ships `.env.example`; `.env` is git-ignored.
- The HiringRoom service user must be read-only in HiringRoom (operational requirement, not enforced by code).

### 3.2 HiringRoom client (`hr/client.ts`)

- Public surface: `login()`, `get(path, query)`, `getBinary(path, maxBytes)`. No methods for POST/PUT/DELETE other than login and refresh.
- Token held in memory; refreshed when less than 5 minutes remain; on `401` re-login once and retry the request once.
- Concurrency cap via `p-limit` (default 5).
- Per-request timeout (default 20 s).
- Retries: `5xx` and network timeouts, 2 retries with 0.5 s and 2 s backoff. `429`: wait `Retry-After` (or 5 s), one retry.
- Maps HTTP errors to typed errors: `AuthError`, `NotFoundError`, `ValidationError(messages[])`, `UpstreamError`.

### 3.3 Dates (`hr/dates.ts`)

- Input format everywhere: ISO `YYYY-MM-DD`, interpreted in `America/Argentina/Buenos_Aires`.
- Converters: ISO → epoch seconds (start of day / end of day), ISO → `DD-MM-YYYY`.
- `splitWindows(desde, hasta, maxDays)` returns contiguous, non-overlapping windows covering the range.

## 4. Tools

### 4.1 Shared conventions

- Inputs validated with Zod before any API call; `desde > hasta` and over-limit ranges are rejected with a Spanish message.
- Dates: ISO `YYYY-MM-DD`.
- Lists return `{ total, items, pagina, hay_mas }` where applicable; `limite` default 20, max 100; `pagina` starts at 1.
- Fields that come back `null` or empty are omitted.
- Fan-out tools return `completo: boolean` and `advertencias: string[]`.
- Responses larger than ~25 KB are trimmed (lists shortened) with `recortado: true`.

### 4.2 Summaries

**Vacancy summary**: `id, nombre, estado, cliente, area, ubicacion, fecha_creacion, fecha_cierre, posiciones, prioridad, responsables[]`. No description or requirements.

**Postulant summary**: `id, nombre_completo, email, vacante{id,nombre}, etapa, rechazado, fecha_postulacion, ubicacion, ultimo_puesto{puesto,empresa,desde,hasta}, anios_experiencia, nivel_estudio, tags[]`.

`anios_experiencia` is the sum of non-overlapping experience intervals, in years with one decimal.

**Sensitive fields**: `dni`, `cuil`, `fechaNacimiento`, `genero`, `fotoPerfil` are never returned by list tools. `ver_postulante` returns phones and email; returns `dni`, `cuil`, `fechaNacimiento` only with `incluir_sensibles: true`. `genero` and `fotoPerfil` are never returned.

### 4.3 Tool list

| # | Tool | Input | Behavior |
|---|---|---|---|
| 1 | `buscar_vacantes` | `estado?[]`, `cliente_o_area_id?`, `creada_desde?`, `creada_hasta?`, `texto?`, `limite`, `pagina` | `GET /vacancies` with `listStatus`, `areaOrCustomerId`, `createdFrom/To`. `texto` filters by name client-side (accent/case-insensitive); when set, the server pages through results (up to 1000 vacancies) before filtering. Returns vacancy summaries. |
| 2 | `ver_vacante` | `id`, `incluir_estadisticas?` | `GET /vacancies/{id}` + `/pipeline/counts` (stage ids mapped to names via the vacancy's `pipelineId`) + `/notes` + `/questions` + `/requirements`. Stats only when requested, 10 s budget; on timeout `estadisticas: "no disponible (timeout)"`. |
| 3 | `buscar_postulantes` | `vacante_id?`, `nombre?`, `apellido?`, `email?`, `etapa?`, `estado?`, `desde?`, `hasta?`, `limite`, `pagina` | `GET /postulants/`. `etapa` accepts a stage name or id; names resolve through `/pipeline/` (ambiguous or unknown names return an error listing valid stages). Returns postulant summaries. |
| 4 | `ver_postulante` | `id`, `incluir_sensibles?` | `GET /postulants/{id}` + `/records` + `/files`. Full profile (experience, education, skills, comments, references, availability, records, files with `fileId`). |
| 5 | `leer_cv` | `postulante_id`, `file_id?`, `max_caracteres` (default 20000, max 60000) | Without `file_id`, picks the first PDF/DOCX. Downloads (max 10 MB), extracts text, normalizes whitespace, returns `{ texto, caracteres, truncado, file_id }`. Unsupported type → explicit error. |
| 6 | `buscar_por_perfil` | `palabras[]`, `excluir?[]`, `vacante_id?` or `desde`+`hasta`, `etapa?`, `max_escanear` (default 1000), `incluir_cv` (default false), `limite` (default 20) | Requires a vacancy or a date range, else error "acotá por vacante o fechas". Scans the scope from `/postulants/` (pages of 100, up to `max_escanear`), scores (section 5), returns ranked summaries with `coincidencias[{palabra, campo}]`, `escaneados`, `total_en_alcance`, `completo`. With `incluir_cv`, reads CVs of the top 30 and re-scores including CV text. |
| 7 | `reporte_contrataciones` | `desde`, `hasta` (max 365 days) | `/postulants/hired/` in 30-day windows. Returns the list (summaries) + totals by vacancy and by month. |
| 8 | `reporte_movimientos_vacantes` | `desde`, `hasta` (max 90 days) | `/vacancies/byChangedStatus` in 7-day windows. Returns movements grouped by status. |
| 9 | `postulaciones_por_dia` | `desde`, `hasta` (max 31 days) | `/postulants/byDay/` per day. Returns count per day + top 10 vacancies by applications. |
| 10 | `catalogos` | `tipo`: `pipelines` \| `clientes` \| `areas` \| `motivos_rechazo` \| `fuentes` | `/pipeline/`, `/account/customers`, `/account/areas`, `/common/rejectReasons`, `/common/sources`. Cached in memory 1 h. |

## 5. Cross-search scoring (`search/perfil.ts`)

- Normalization: lowercase, strip accents (NFD), collapse whitespace; words match on token prefix (e.g. `soldad` matches `soldador`, `soldadura`).
- Field weights: position titles (`experienciasLaborales[].puesto`) 3; education titles 2; experience area/subarea 2; tags 2; experience descriptions 1; `presentacionPostulante` 1; location (province/city) 1; CV text (when `incluir_cv`) 1.
- Score = sum over matched words of the max weight among fields where the word matched; each matched word counted once.
- Any `excluir` word matching anywhere removes the candidate.
- A candidate must match at least one word to be returned. Ties broken by most recent `fechaPostulacion`.
- The same person may appear once per application; results are deduplicated by postulant `id`, keeping the highest score and listing the vacancies.

## 6. Errors and limits

### 6.1 Error handling

Tools never throw to the SDK; they return `isError: true` with a short Spanish message and a hint.

| Condition | Message |
|---|---|
| `401` after re-login | "credenciales de HiringRoom inválidas, revisar .env" |
| `404` | "no existe <recurso> `<id>`" |
| `422` | API `errors[].message` passed through (except known empty-result cases, which return empty) |
| `5xx`/timeout after retries | "HiringRoom no responde, reintentar más tarde" |
| Zod validation | field-specific message |

Fan-out tools (`buscar_por_perfil`, reports, `postulaciones_por_dia`, `buscar_vacantes` with `texto`) tolerate partial failure: failed pages/windows go into `advertencias`, `completo: false`.

### 6.2 Limits (defaults, env-overridable)

| Limit | Default |
|---|---|
| Concurrent HR requests | 5 |
| Per-request timeout | 20 s |
| Stats budget | 10 s |
| `buscar_por_perfil` max scanned | 1000 |
| `buscar_por_perfil` CVs read | top 30 |
| `buscar_por_perfil` total budget | 90 s (returns partial with `completo: false`) |
| CV download max | 10 MB |
| CV text default / max | 20,000 / 60,000 chars |
| Tool response size | ~25 KB before trimming |
| Catalog/pipeline cache | 1 h |

## 7. Security and privacy

- Secrets never logged or returned; logger redacts `token`, `password`, `client_secret`, `refreshToken` and the `token` header.
- HR client exposes only GET + login/refresh.
- CV bytes and text live only in memory; if extraction needs a temp file it goes to an OS temp dir and is deleted in `finally`.
- Test fixtures are synthetic; no real Patagonia personal data in the repo.
- Operational logs go to stderr (stdout is the MCP protocol).
- Data passes through Claude; Patagonia's agreement on this is a prerequisite before real use (open item, section 10).

## 8. Audit

- File: `~/.local/state/hiringroom-mcp/audit.jsonl`, one line per tool call.
- Fields: `ts, tool, params, ms, resultado (ok|error), n_items, completo`.
- `params.email`, `params.nombre`, `params.apellido` are replaced by a SHA-256 prefix (12 hex chars).
- Rotation at 5 MB, keep last 5 files.

## 9. Repo, stack and tests

### 9.1 Layout

```
src/
  index.ts          stdio entry, registers tools
  config.ts
  hr/client.ts
  hr/dates.ts
  shape/*.ts
  search/perfil.ts
  cv/extract.ts
  tools/*.ts
  audit.ts
test/
  fixtures/         synthetic payloads matching real shapes
  *.test.ts
scripts/smoke.ts    manual read-only run against the real API
docs/specs/
```

- Stack: Node 22, TypeScript, `@modelcontextprotocol/sdk`, `zod`, `vitest`, `undici`, `p-limit`, `mammoth` (DOCX), system `pdftotext` (poppler).
- Install: `claude mcp add hiringroom -- node <path>/dist/index.js` (user or project scope); README documents it.
- Git: local only until a remote is decided.

### 9.2 Tests (TDD)

- Unit: date conversion and window splitting; shaping (sensitive fields absent unless opted in); `anios_experiencia` with overlapping intervals; scoring (accents, case, prefixes, weights, exclusions, dedup); size trimming; log/audit redaction.
- HR client with mocked fetch: `401` → re-login + retry; `5xx` → retry with backoff; timeout; `429`; concurrency cap; no non-GET methods exposed.
- Tools: each tool through the SDK in-memory client against a fake HR; Zod validation; partial results (`completo: false`); empty-result `422` cases.
- Smoke (`npm run smoke`, manual, not CI): hits the real API with the secrets file, prints counts and timings only.

## 10. Acceptance criteria

1. After `claude mcp add` and restarting Claude Code, the 10 tools are listed.
2. "¿Qué vacantes activas hay?" returns active vacancies with correct per-stage counts.
3. "Postulantes en Entrevista de la vacante X" resolves the stage by name and returns the correct set.
4. "Contrataciones de los últimos 90 días" returns a correct total using 3 windows.
5. "Buscá soldadores con experiencia en Neuquén entre los postulantes de agosto" returns a ranking with match reasons and `escaneados/total_en_alcance`.
6. "Leé el CV de <postulante>" returns text, truncated when over the limit.
7. No response contains DNI or date of birth unless explicitly requested.
8. The audit log has one line per call and no plain-text names or emails.
9. With a wrong password, the tools return a clear error and the server does not crash.

## 11. Open items

- Patagonia's agreement that candidate data (including CV text) passes through Vitu and Claude.
- Confirm the HiringRoom service user is read-only.
- Ask HiringRoom to enable `client_credentials` for the app (removes the stored password; not blocking).
- Move the current secrets file from the repo dir to `~/.config/hiringroom-mcp/.env`.
