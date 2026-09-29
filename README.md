# hiringroom-mcp

Local stdio MCP server that gives Claude Code **read-only** access to Patagonia Resources' HiringRoom account.
Design: `docs/specs/2026-09-23-hiringroom-mcp-design.md`.

## Requirements

- Node 22+
- `pdftotext` on the `PATH` (macOS: `brew install poppler`; Windows: `scoop install poppler` or `choco install poppler`)
- A read-only HiringRoom service user plus the API `client_id` / `client_secret`

## Setup

```bash
npm ci && npm run build
mkdir -p ~/.config/hiringroom-mcp
cp .env.example ~/.config/hiringroom-mcp/.env   # fill it in
chmod 600 ~/.config/hiringroom-mcp/.env
claude mcp add --scope user hiringroom -- node "$(pwd)/dist/index.js"
```

On Windows (PowerShell):

```powershell
npm ci; npm run build
mkdir -Force $HOME\.config\hiringroom-mcp
copy .env.example $HOME\.config\hiringroom-mcp\.env   # fill it in
claude mcp add --scope user hiringroom -- node "$PWD\dist\index.js"
```

Windows has no POSIX file modes, so the `chmod 600` check is skipped there; the file is protected by the NTFS permissions of your user profile. Keep it under `$HOME` (or point `HIRINGROOM_ENV_FILE` somewhere equally private).

Restart Claude Code and run `/mcp` to check that `hiringroom` is connected.

## Tools

| Tool | Purpose |
|---|---|
| `buscar_vacantes` | Filter vacancies by status, client/area, creation dates, name text |
| `ver_vacante` | Vacancy detail, pipeline counts by stage, notes, questions, optional stats |
| `buscar_postulantes` | Filter applications by vacancy, name, email, stage, status, dates |
| `ver_postulante` | Full profile, records, attachments (`incluir_sensibles` for DNI/birth date) |
| `leer_cv` | Text of a PDF/DOCX CV |
| `buscar_por_perfil` | Scoped keyword cross-search with ranking and match reasons |
| `reporte_contrataciones` | Hires in a range (≤365 days), by vacancy and month |
| `reporte_movimientos_vacantes` | Vacancy status changes (≤90 days) |
| `postulaciones_por_dia` | Applications per day (≤31 days) + top vacancies |
| `catalogos` | Pipelines/stages, clients, areas, reject reasons, sources |

## Operations

- Secrets: `~/.config/hiringroom-mcp/.env` (override with `HIRINGROOM_ENV_FILE`). Must be mode 600 (not checked on Windows). Credentials are read only from this file, never from the process environment; the `HR_MCP_*` limits and path overrides are process env vars (e.g. `claude mcp add -e HR_MCP_CONCURRENCY=3 ...`).
- `leer_cv` returns the full CV text verbatim, which usually contains personal data such as DNI or date of birth; asking for a CV counts as the explicit request for that data.
- Audit log: `~/.local/state/hiringroom-mcp/audit.jsonl` (override with `HR_MCP_AUDIT_DIR`). One line per call; emails and names are hashed.
- Limits: see `src/config.ts` (`HR_MCP_*` env vars).
- `npm test` — unit + tool tests (synthetic data). `npm run smoke` — manual read-only check against the real API; prints counts, timings and key names only.
