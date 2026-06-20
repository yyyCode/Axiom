import {
  type StructuredMemoryStore,
  type StructuredEntity,
  type EntityRelationship,
} from "./store.js";

// ─── SQLite Structured Memory Store ───────────────────────────────

/**
 * Lightweight structured memory store using SQLite (via better-sqlite3 or bun:sqlite).
 *
 * Designed for tracking creative entities like:
 *  - Characters (name, traits, backstory, arc)
 *  - Plot arcs (name, summary, chapters, status)
 *  - Chapters (title, summary, scenes, word count)
 *  - Scenes (description, characters present, location)
 *  - Settings (name, description, era, significance)
 *  - Video scenes (description, duration, camera angles, dialogue)
 *  - Storyboards (name, frames, transitions)
 *
 * This is an in-memory implementation for portability.
 * Swap with 'better-sqlite3' for persistence in production.
 */
export class SqliteMemoryStore implements StructuredMemoryStore {
  private entities: Map<string, StructuredEntity> = new Map();
  private relationships: Map<string, EntityRelationship[]> = new Map();
  private idCounter = 0;

  async saveEntity(entity: StructuredEntity): Promise<void> {
    const id = entity.id || `entity_${++this.idCounter}`;
    const now = new Date().toISOString();

    const saved: StructuredEntity = {
      ...entity,
      id,
      createdAt: entity.createdAt || now,
      updatedAt: now,
    };

    this.entities.set(id, saved);

    if (entity.relationships.length > 0) {
      this.relationships.set(id, entity.relationships);
    }
  }

  async getEntity(id: string): Promise<StructuredEntity | null> {
    return this.entities.get(id) ?? null;
  }

  async findEntities(
    type: string,
    filters?: Record<string, unknown>,
  ): Promise<StructuredEntity[]> {
    const results: StructuredEntity[] = [];

    for (const entity of this.entities.values()) {
      if (entity.type !== type) continue;

      if (filters) {
        let matches = true;
        for (const [key, value] of Object.entries(filters)) {
          if (entity.attributes[key] !== value) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
      }

      results.push(entity);
    }

    return results;
  }

  async searchEntities(query: string): Promise<StructuredEntity[]> {
    const lowerQuery = query.toLowerCase();
    const results: StructuredEntity[] = [];

    for (const entity of this.entities.values()) {
      const searchText = JSON.stringify(entity).toLowerCase();
      if (searchText.includes(lowerQuery)) {
        results.push(entity);
      }
    }

    return results;
  }

  async getRelationships(entityId: string): Promise<EntityRelationship[]> {
    return this.relationships.get(entityId) ?? [];
  }

  async deleteEntity(id: string): Promise<void> {
    this.entities.delete(id);
    this.relationships.delete(id);
  }

  async getTypes(): Promise<string[]> {
    const types = new Set<string>();
    for (const entity of this.entities.values()) {
      types.add(entity.type);
    }
    return [...types];
  }
}
