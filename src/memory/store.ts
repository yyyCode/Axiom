// ─── Memory System Interfaces ────────────────────────────────────

/** A single memory entry */
export interface MemoryEntry {
  /** File-safe slug name */
  name: string;
  /** One-line summary for indexing */
  description: string;
  /** Type of memory */
  type: "user" | "feedback" | "project" | "reference";
  /** The memory content */
  content: string;
  /** Arbitrary metadata */
  metadata: Record<string, string>;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/** Memory storage interface — pluggable backends */
export interface MemoryStore {
  /** Store a memory entry (upsert by name) */
  save(entry: MemoryEntry): Promise<void>;

  /** Load a memory by name */
  load(name: string): Promise<MemoryEntry | null>;

  /** List all memory names */
  list(): Promise<string[]>;

  /** Search memories by description (for auto-loading relevant ones) */
  search(query: string, limit?: number): Promise<MemoryEntry[]>;

  /** Delete a memory */
  delete(name: string): Promise<void>;

  /** Get total memory count */
  count(): Promise<number>;
}

// ─── Structured Memory ───────────────────────────────────────────

/** A structured entity for tracking creative assets (characters, plots, etc.) */
export interface StructuredEntity {
  id: string;
  type: string; // e.g. "character", "plot_arc", "chapter", "scene", "setting"
  name: string;
  attributes: Record<string, unknown>;
  relationships: EntityRelationship[];
  createdAt: string;
  updatedAt: string;
}

export interface EntityRelationship {
  targetId: string;
  relationType: string; // e.g. "appears_in", "parent_of", "follows"
  metadata?: Record<string, string>;
}

/** Structured memory store for creative entities */
export interface StructuredMemoryStore {
  /** Create or update an entity */
  saveEntity(entity: StructuredEntity): Promise<void>;

  /** Get an entity by ID */
  getEntity(id: string): Promise<StructuredEntity | null>;

  /** Find entities by type with optional attribute filters */
  findEntities(
    type: string,
    filters?: Record<string, unknown>,
  ): Promise<StructuredEntity[]>;

  /** Search entities by name/attributes */
  searchEntities(query: string): Promise<StructuredEntity[]>;

  /** Get all relationships for an entity */
  getRelationships(entityId: string): Promise<EntityRelationship[]>;

  /** Delete an entity */
  deleteEntity(id: string): Promise<void>;

  /** Get all entity types in use */
  getTypes(): Promise<string[]>;
}

// ─── Index File Format (MEMORY.md) ───────────────────────────────

/**
 * Format a memory index entry for the MEMORY.md file.
 * Format: `- [Title](file.md) — description`
 */
export function formatMemoryIndexEntry(entry: MemoryEntry): string {
  return `- [${entry.name}](${entry.name}.md) — ${entry.description}`;
}

/**
 * Parse a MEMORY.md index file into individual entries.
 */
export function parseMemoryIndex(content: string): Array<{ name: string; description: string }> {
  const entries: Array<{ name: string; description: string }> = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^- \[(.+?)\]\((.+?)\.md\) — (.+)$/);
    if (match) {
      entries.push({
        name: match[1] ?? "",
        description: match[3] ?? "",
      });
    }
  }

  return entries;
}
