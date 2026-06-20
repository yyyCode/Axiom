import fs from "node:fs/promises";
import path from "node:path";
import {
  type MemoryStore,
  type MemoryEntry,
  formatMemoryIndexEntry,
} from "./store.js";

// ─── File-Based Memory Store ──────────────────────────────────────

/**
 * Markdown file-based memory store.
 *
 * Architecture inspired by Claude Code: each memory is a single Markdown
 * file with YAML frontmatter. An index file (MEMORY.md) lists all memories.
 *
 * File format:
 * ```
 * ---
 * name: short-kebab-case-slug
 * description: one-line summary
 * metadata:
 *   type: user | feedback | project | reference
 * ---
 *
 * <memory content>
 * ```
 */
export class FileMemoryStore implements MemoryStore {
  private storagePath: string;
  private indexFile: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.indexFile = path.join(storagePath, "MEMORY.md");
  }

  /** Initialize the storage directory */
  async init(): Promise<void> {
    await fs.mkdir(this.storagePath, { recursive: true });
    try {
      await fs.access(this.indexFile);
    } catch {
      await fs.writeFile(this.indexFile, "# Memory Index\n\n", "utf-8");
    }
  }

  async save(entry: MemoryEntry): Promise<void> {
    await this.init();

    const frontmatter = [
      "---",
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      "metadata:",
      `  type: ${entry.type}`,
      ...Object.entries(entry.metadata).map(([k, v]) => `  ${k}: ${v}`),
      "---",
    ].join("\n");

    const fileContent = `${frontmatter}\n\n${entry.content}`;
    const filePath = path.join(this.storagePath, `${entry.name}.md`);
    await fs.writeFile(filePath, fileContent, "utf-8");

    // Update index
    await this.updateIndex(entry);
  }

  async load(name: string): Promise<MemoryEntry | null> {
    await this.init();
    const filePath = path.join(this.storagePath, `${name}.md`);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      return this.parseMemoryFile(name, content);
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    await this.init();
    const entries: string[] = [];

    try {
      const files = await fs.readdir(this.storagePath);
      for (const file of files) {
        if (file.endsWith(".md") && file !== "MEMORY.md") {
          entries.push(file.replace(/\.md$/, ""));
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return entries;
  }

  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    const names = await this.list();
    const results: MemoryEntry[] = [];

    const queryLower = query.toLowerCase();
    for (const name of names) {
      const entry = await this.load(name);
      if (!entry) continue;

      const searchText =
        `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
      if (searchText.includes(queryLower)) {
        results.push(entry);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  async delete(name: string): Promise<void> {
    await this.init();
    const filePath = path.join(this.storagePath, `${name}.md`);

    try {
      await fs.unlink(filePath);
      await this.removeFromIndex(name);
    } catch {
      // File doesn't exist
    }
  }

  async count(): Promise<number> {
    const names = await this.list();
    return names.length;
  }

  // ─── Private ─────────────────────────────────────────────────

  private async updateIndex(entry: MemoryEntry): Promise<void> {
    let index: string;
    try {
      index = await fs.readFile(this.indexFile, "utf-8");
    } catch {
      index = "# Memory Index\n\n";
    }

    const line = formatMemoryIndexEntry(entry);
    const escapedName = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (new RegExp(`^- \\[${escapedName}\\]`).test(index)) {
      // Update existing entry
      index = index.replace(
        new RegExp(`^- \\[${escapedName}\\].*$`, "m"),
        line,
      );
    } else {
      // Add new entry
      index += `${line}\n`;
    }

    await fs.writeFile(this.indexFile, index, "utf-8");
  }

  private async removeFromIndex(name: string): Promise<void> {
    try {
      let index = await fs.readFile(this.indexFile, "utf-8");
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index = index.replace(
        new RegExp(`^- \\[${escapedName}\\].*\\n?`, "m"),
        "",
      );
      await fs.writeFile(this.indexFile, index, "utf-8");
    } catch {
      // File doesn't exist
    }
  }

  private parseMemoryFile(
    name: string,
    content: string,
  ): MemoryEntry | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1] ?? "";
    const body = frontmatterMatch[2] ?? "";

    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? "";
    const type = (frontmatter.match(/^\s+type:\s*(.+)$/m)?.[1] ?? "reference") as
      MemoryEntry["type"];

    const metadata: Record<string, string> = {};
    const metaSection = frontmatter.match(/^metadata:\n([\s\S]*?)$/m);
    if (metaSection) {
      const metaLines = metaSection[1]?.split("\n") ?? [];
      for (const line of metaLines) {
        const m = line.match(/^\s+(\w+):\s*(.+)$/);
        const key = m?.[1];
        if (key && key !== "type") {
          metadata[key] = (m[2] ?? "").trim();
        }
      }
    }

    // Extract file dates
    const createdMatch = content.match(/^created:\s*(.+)$/m);
    const updatedMatch = content.match(/^updated:\s*(.+)$/m);

    return {
      name,
      description,
      type,
      content: body.trim(),
      metadata,
      createdAt: createdMatch?.[1] ?? new Date().toISOString(),
      updatedAt: updatedMatch?.[1] ?? new Date().toISOString(),
    };
  }
}
