import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import mammoth from "mammoth";
import { ConfigError } from "../config.js";
import { InputError } from "../errors.js";

const run = promisify(execFile);

export type CvKind = "pdf" | "docx" | "otro";

export async function assertPdftotext(): Promise<void> {
  try {
    await run("pdftotext", ["-v"]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("falta pdftotext en el PATH (macOS: brew install poppler)");
    }
    // pdftotext -v exits non-zero on some builds; being found is enough.
  }
}

export function detectKind(bytes: Buffer): CvKind {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "docx";
  return "otro";
}

export function cleanText(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(s: string, max: number): { texto: string; truncado: boolean } {
  return s.length > max ? { texto: s.slice(0, max), truncado: true } : { texto: s, truncado: false };
}

async function pdfText(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hrmcp-"));
  try {
    const file = join(dir, "cv.pdf");
    await writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run("pdftotext", ["-enc", "UTF-8", file, "-"], { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractText(bytes: Buffer): Promise<string> {
  const kind = detectKind(bytes);
  if (kind === "pdf") return cleanText(await pdfText(bytes));
  if (kind === "docx") return cleanText((await mammoth.extractRawText({ buffer: bytes })).value);
  throw new InputError("formato de archivo no soportado (solo PDF o DOCX)");
}
