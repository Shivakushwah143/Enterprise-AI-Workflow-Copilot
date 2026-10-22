/**
 * Semantic retrieval with an honest capability ladder.
 *
 *   provider configured + pgvector  -> vector search, keyword as fallback
 *   provider missing                -> keyword search only, reported as
 *                                      `unconfigured` by /api/capabilities
 *
 * Embeddings are never synthesized locally and never faked: with no provider
 * the vector path returns nothing and says why.
 */
import type { CapabilityStatus } from "@copilot/shared";
import type { Store, DocumentChunkHit } from "./store.js";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 1536;

  constructor(
    private readonly apiKey: string,
    private readonly model = "text-embedding-3-small",
    private readonly baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`embedding provider failed: ${response.status}`);
    }
    const payload = (await response.json()) as {
      data?: { embedding: number[] }[];
    };
    const vectors = payload.data?.map((d) => d.embedding) ?? [];
    if (vectors.length !== texts.length) {
      throw new Error("embedding provider returned an unexpected count");
    }
    return vectors;
  }
}

export function configuredEmbeddingProvider(): EmbeddingProvider | null {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "").toLowerCase();
  const apiKey = process.env.OPENAI_API_KEY;
  if (provider === "openai" && apiKey) return new OpenAIEmbeddings(apiKey);
  return null;
}

export interface RetrievalResult {
  hits: DocumentChunkHit[];
  method: "keyword" | "vector";
  notice: string | null;
}

export class KnowledgeEngine {
  constructor(
    private readonly store: Store,
    private readonly provider: EmbeddingProvider | null = configuredEmbeddingProvider(),
  ) {}

  vectorStatus(): { status: CapabilityStatus; detail: string } {
    if (!this.provider) {
      return {
        status: "unconfigured",
        detail:
          "No embedding provider configured (set EMBEDDING_PROVIDER=openai and OPENAI_API_KEY). Keyword retrieval is active; vector search is not.",
      };
    }
    if (!this.store.sql.vectorAvailable()) {
      return {
        status: "blocked",
        detail:
          "Embedding provider configured but the pgvector extension is unavailable in this database; retrieval stays keyword-only.",
      };
    }
    return {
      status: "configured",
      detail: `Vector search active via ${this.provider.name} (${this.provider.dimensions}d) over pgvector.`,
    };
  }

  async ingest(input: {
    tenantId: string;
    applicationId: string | null;
    title: string;
    kind: "sop" | "doc";
    content: string;
  }): Promise<{ documentId: string; chunks: number; embedded: number }> {
    const { documentId, chunks } = await this.store.addDocument(input);
    if (!this.provider) return { documentId, chunks, embedded: 0 };

    const rows = await this.store.sql.query<{ id: string; content: string }>(
      "SELECT id, content FROM doc_chunks WHERE tenant_id = $1 AND document_id = $2 ORDER BY idx",
      [input.tenantId, documentId],
    );
    let embedded = 0;
    for (const row of rows) {
      try {
        const [vector] = await this.provider.embed([row.content]);
        if (vector && (await this.store.storeEmbedding(input.tenantId, row.id, vector))) {
          embedded += 1;
        }
      } catch (error) {
        return {
          documentId,
          chunks,
          embedded,
          ...{ warning: error instanceof Error ? error.message : "embedding failed" },
        };
      }
    }
    return { documentId, chunks, embedded };
  }

  async search(tenantId: string, query: string, limit = 5): Promise<RetrievalResult> {
    if (this.provider) {
      try {
        const [vector] = await this.provider.embed([query]);
        if (vector) {
          const hits = await this.store.searchChunksVector(tenantId, vector, limit);
          if (hits.length > 0) {
            return { hits, method: "vector", notice: null };
          }
        }
      } catch (error) {
        const keyword = await this.store.searchChunksKeyword(tenantId, query, limit);
        return {
          hits: keyword,
          method: "keyword",
          notice: `Vector search failed (${error instanceof Error ? error.message : "unknown"}); keyword retrieval used instead.`,
        };
      }
    }
    return {
      hits: await this.store.searchChunksKeyword(tenantId, query, limit),
      method: "keyword",
      notice: this.provider ? null : "Vector search unconfigured; keyword retrieval used.",
    };
  }
}
