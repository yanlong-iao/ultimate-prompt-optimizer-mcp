/** Local persistence: history (versions of optimized prompts) and reports, under UPO_DATA_DIR (default: project folder). */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");

export async function writeReport(dataDir: string, name: string, files: Record<string, string>): Promise<Record<string, string>> {
  const dir = join(dataDir, "reports");
  await mkdir(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const [ext, content] of Object.entries(files)) {
    const p = join(dir, `${name}.${ext}`);
    await writeFile(p, content, "utf8");
    out[ext] = p;
  }
  return out;
}

export interface HistoryRecord {
  id: string;
  tool: string;
  createdAt: string;
  title: string;
  input: string;
  final: string;
  meta: Record<string, unknown>;
  versions?: Array<{ label: string; prompt: string; score?: number }>;
}

export class HistoryStore {
  constructor(private readonly dataDir: string) {}

  private get dir() {
    return join(this.dataDir, "history");
  }

  async save(rec: Omit<HistoryRecord, "id" | "createdAt">): Promise<HistoryRecord> {
    await mkdir(this.dir, { recursive: true });
    const full: HistoryRecord = { id: `${stamp()}-${rec.tool}`, createdAt: new Date().toISOString(), ...rec };
    await writeFile(join(this.dir, `${full.id}.json`), JSON.stringify(full, null, 2), "utf8");
    return full;
  }

  async list(limit = 20): Promise<HistoryRecord[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
    } catch {
      return [];
    }
    const out: HistoryRecord[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")));
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }

  async get(id: string): Promise<HistoryRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${id.replace(/[^\w.-]/g, "")}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }
}
