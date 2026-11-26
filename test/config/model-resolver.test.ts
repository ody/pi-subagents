import { describe, expect, it } from "vitest";
import { describeModel, type ModelRegistry, matchModel } from "../../src/config/model-resolver.js";
import { resolveModel } from "../../src/config/model-scope.js";

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

const OPUS = MODELS[0];
const SONNET = MODELS[1];
const HAIKU = MODELS[2];
const GPT_4O = MODELS[3];
const GEMINI = MODELS[5];

type Fixture = { id: string; name: string; provider: string };

function makeRegistry(models: Fixture[] = MODELS, available?: Fixture[]): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models.find(m => m.provider === provider && m.id === modelId);
    },
    getAll() {
      return models;
    },
    getAvailable: () => available ?? models,
  };
}

function expectNoModel(input: string, registry: ModelRegistry = makeRegistry()) {
  const result = resolveModel(input, registry);
  expect(typeof result).toBe("string");
  return result as string;
}

describe("matchModel", () => {
  describe("literal keys and normalized ids before shorthand", () => {
    it("resolves a literal provider/id", () => {
      expect(resolveModel("anthropic/claude-opus-4-6", makeRegistry())).toEqual(OPUS);
    });

    it("resolves a literal key ahead of a shorthand sibling", () => {
      expect(resolveModel("openai/gpt-4o", makeRegistry())).toEqual(GPT_4O);
      expect(resolveModel("gpt-4o", makeRegistry())).toEqual(GPT_4O);
    });

    it("treats dots and dashes as equal in a complete id", () => {
      expect(resolveModel("gemini-2-5-pro", makeRegistry())).toEqual(GEMINI);
      expect(resolveModel("claude-haiku-4.5", makeRegistry())).toEqual(HAIKU);
    });

    it("matches case-insensitively", () => {
      expect(resolveModel("Claude-Opus-4-6", makeRegistry())).toEqual(OPUS);
      expect(resolveModel("HAIKU", makeRegistry())).toEqual(HAIKU);
    });

    it("matches the base id of an undated input to a dated id", () => {
      expect(resolveModel("claude-haiku-4-5", makeRegistry())).toEqual(HAIKU);
      expect(resolveModel("anthropic/claude-haiku-4.5", makeRegistry())).toEqual(HAIKU);
    });

    it("does not resolve the prefix of a longer id", () => {
      const pool = [{ id: "claude-sonnet-46", name: "Claude Sonnet 46", provider: "anthropic" }];
      expectNoModel("claude-sonnet-4", makeRegistry(pool));
    });
  });

  describe("whole-token shorthand", () => {
    it("resolves a single token", () => {
      expect(resolveModel("sonnet", makeRegistry())).toEqual(SONNET);
      expect(resolveModel("opus", makeRegistry())).toEqual(OPUS);
      expect(resolveModel("haiku", makeRegistry())).toEqual(HAIKU);
      expect(resolveModel("gemini", makeRegistry())).toEqual(GEMINI);
    });

    it("resolves tokens from the display name", () => {
      expect(resolveModel("Opus 4.6", makeRegistry())).toEqual(OPUS);
      expect(resolveModel("Haiku 4.5", makeRegistry())).toEqual(HAIKU);
    });

    it("matches capitalized display names and ids", () => {
      const pool = [{ id: "MODEL-4-6", name: "Claude Sonnet 4.6", provider: "example" }];
      expect(resolveModel("sonnet 4.6", makeRegistry(pool))).toEqual(pool[0]);
      expect(resolveModel("model 4.6", makeRegistry(pool))).toEqual(pool[0]);
    });

    it("does not match a substring of a token", () => {
      expectNoModel("sonn", makeRegistry());
      expectNoModel("haik", makeRegistry());
      expectNoModel("opus-4", makeRegistry());
    });

    it("does not combine id tokens with name tokens", () => {
      const pool = [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" }];
      expect(resolveModel("claude 4.6", makeRegistry(pool))).toEqual(pool[0]);
      expectNoModel("anthropic sonnet", makeRegistry(pool));
    });
  });

  describe("versions and snapshots", () => {
    const SONNET_45 = { id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5", provider: "anthropic" };

    it("resolves an explicit version by shorthand", () => {
      expect(resolveModel("sonnet 4.5", makeRegistry([SONNET_45]))).toEqual(SONNET_45);
    });

    it("refuses a version the id does not have", () => {
      expectNoModel("claude-sonnet-4-5", makeRegistry([SONNET]));
      expectNoModel("sonnet 4.5", makeRegistry([SONNET]));
    });

    it("refuses reordered version components", () => {
      expectNoModel("claude-sonnet-5-4", makeRegistry([SONNET_45]));
    });

    it("refuses a version prefix of the complete version", () => {
      const pool = [{ id: "claude-sonnet-4-5-1", name: "Claude Sonnet 4.5.1", provider: "anthropic" }];
      expectNoModel("claude-sonnet-4-5", makeRegistry(pool));
    });

    it("matches an explicit snapshot date", () => {
      expect(resolveModel("claude-haiku-4-5-20251001", makeRegistry())).toEqual(HAIKU);
      expect(resolveModel("claude-haiku-4.5-20251001", makeRegistry())).toEqual(HAIKU);
      expect(resolveModel("anthropic/claude-haiku-4-5-20251001", makeRegistry())).toEqual(HAIKU);
    });

    it("refuses a snapshot date the available ids do not have", () => {
      expectNoModel("claude-haiku-4-5-20251022", makeRegistry());
      expectNoModel("claude-haiku-4-5-20241022", makeRegistry());
    });

    it("refuses an explicit date when the id is undated", () => {
      const undated = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" };
      expectNoModel("anthropic/claude-haiku-4-5-20251001", makeRegistry([undated]));
    });
  });

  describe("provider scope and fallback", () => {
    const gatewayHaiku = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "openrouter" };
    const anthropicHaiku = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" };

    it("prefers the named provider", () => {
      const pool = [gatewayHaiku, anthropicHaiku];
      expect(resolveModel("anthropic/claude-haiku-4-5", makeRegistry(pool))).toEqual(anthropicHaiku);
    });

    it("falls back to another provider when the named one has no candidate", () => {
      expect(resolveModel("anthropic/claude-haiku-4-5", makeRegistry([gatewayHaiku]))).toEqual(gatewayHaiku);
    });

    it("scans the pool with the text after the first slash", () => {
      const pool = [
        { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "openrouter" },
        { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
      ];
      expect(resolveModel("gateway/claude-opus-4-6", makeRegistry(pool))).toEqual(pool[1]);
    });

    it("does not fall back when the named provider is ambiguous", () => {
      const pool = [
        { id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "openrouter" },
      ];
      const match = matchModel("anthropic/sonnet", makeRegistry(pool));
      expect(match).toEqual({
        kind: "ambiguous",
        candidates: ["anthropic/claude-sonnet-4-5-20241022", "anthropic/claude-sonnet-4-6"],
      });
      expectNoModel("anthropic/sonnet", makeRegistry(pool));
    });
  });

  describe("ambiguity and deterministic ties", () => {
    it("reports ambiguity between distinct base ids", () => {
      const pool = [
        { id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
        { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
      ];
      const match = matchModel("sonnet", makeRegistry(pool));
      expect(match).toEqual({
        kind: "ambiguous",
        candidates: ["anthropic/claude-sonnet-4-5-20241022", "anthropic/claude-sonnet-4-6"],
      });
    });

    it("resolves a duplicate id across providers by the smallest provider/id", () => {
      const pool = [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "openrouter" },
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
      ];
      expect(resolveModel("claude-sonnet-4-5", makeRegistry(pool))).toEqual(pool[1]);
      expect(resolveModel("claude-sonnet-4-5", makeRegistry([...pool].reverse()))).toEqual(pool[1]);
    });

    it("prefers the newest snapshot for an undated input", () => {
      const newest = { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" };
      const older = { id: "claude-haiku-4-5-20250901", name: "Claude Haiku 4.5", provider: "anthropic" };
      expect(resolveModel("claude-haiku-4-5", makeRegistry([newest, older]))).toEqual(newest);
      expect(resolveModel("claude-haiku-4-5", makeRegistry([older, newest]))).toEqual(newest);
    });

    it("prefers an undated id over a snapshot", () => {
      const undated = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" };
      const dated = { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" };
      expect(resolveModel("haiku", makeRegistry([dated, undated]))).toEqual(undated);
      expect(resolveModel("haiku", makeRegistry([undated, dated]))).toEqual(undated);
    });
  });

  describe("invalid input", () => {
    it("resolves nothing for blank and whitespace-only input", () => {
      expect(matchModel("", makeRegistry())).toEqual({ kind: "unspecified" });
      expect(matchModel("   ", makeRegistry())).toEqual({ kind: "unspecified" });
      expectNoModel("");
      expectNoModel("   ");
    });

    it("resolves nothing for an empty or date-only model part", () => {
      expect(matchModel("anthropic/", makeRegistry())).toEqual({ kind: "unspecified" });
      expect(matchModel("anthropic/   ", makeRegistry())).toEqual({ kind: "unspecified" });
      expect(matchModel("anthropic/20251001", makeRegistry())).toEqual({ kind: "unspecified" });
      expect(matchModel("20251001", makeRegistry())).toEqual({ kind: "unspecified" });
      expectNoModel("anthropic/20251001");
    });

    it("reports a miss with the accepted models", () => {
      const message = expectNoModel("nonexistent-model");
      expect(message).toContain('Model not found: "nonexistent-model"');
      expect(message).toContain("Accepted models:");
      expect(message).toContain("  anthropic/claude-opus-4-6");
      expect(message).toContain("  openai/gpt-4o");
    });

    it("reports a miss on an empty pool", () => {
      expect(matchModel("haiku", makeRegistry([]))).toEqual({ kind: "not_found" });
      expect(expectNoModel("haiku", makeRegistry([]))).toContain("Model not found");
    });
  });

  describe("available models only", () => {
    it("matches against getAvailable, not the full catalog", () => {
      const available = [OPUS, HAIKU];
      const registry = makeRegistry(MODELS, available);
      expect(resolveModel("haiku", registry)).toEqual(HAIKU);
      expect(resolveModel("sonnet", registry)).toBeTypeOf("string");
      expect(resolveModel("anthropic/claude-sonnet-4-6", registry)).toBeTypeOf("string");
    });

    it("does not substitute the catalog when getAvailable is absent", () => {
      const registry = { ...makeRegistry(), getAvailable: undefined };
      expect(matchModel("opus", registry)).toEqual({ kind: "not_found" });
    });

    it("resolves nothing when getAvailable is empty", () => {
      expect(matchModel("claude-opus-4-6", makeRegistry(MODELS, []))).toEqual({ kind: "not_found" });
      expect(matchModel("anthropic/claude-opus-4-6", makeRegistry(MODELS, []))).toEqual({ kind: "not_found" });
    });
  });

  describe("scope disambiguation", () => {
    const SIMILAR_MODELS = [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      { id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5", provider: "anthropic" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
    ];
    const registry = makeRegistry(SIMILAR_MODELS);
    const scope = (...models: Fixture[]) => models.map(m => `${m.provider}/${m.id}`);

    it("resolves shorthand that is unique in scope", () => {
      expect(resolveModel("sonnet", registry, { scope: scope(SIMILAR_MODELS[0]) })).toEqual(SIMILAR_MODELS[0]);
      expect(resolveModel("sonnet", registry, { scope: scope(SIMILAR_MODELS[1]) })).toEqual(SIMILAR_MODELS[1]);
    });

    it("stays ambiguous when scope holds several base ids", () => {
      expect(matchModel("sonnet", registry, { scope: scope(SIMILAR_MODELS[0], SIMILAR_MODELS[1]) }))
        .toEqual({ kind: "ambiguous", candidates: ["anthropic/claude-sonnet-4-5-20241022", "anthropic/claude-sonnet-4-6"] });
    });

    it("resolves nothing when no candidate is in scope", () => {
      expect(matchModel("sonnet", registry, { scope: scope(SIMILAR_MODELS[2]) }).kind).toBe("ambiguous");
    });

    it("ignores scope for an exact id", () => {
      const unrelated = scope(SIMILAR_MODELS[2]);
      expect(resolveModel("anthropic/claude-sonnet-4-6", registry, { scope: unrelated })).toEqual(SIMILAR_MODELS[0]);
      expect(resolveModel("claude-sonnet-4-5-20241022", registry, { scope: unrelated })).toEqual(SIMILAR_MODELS[1]);
    });

    it("resolves a single shorthand candidate that scope holds", () => {
      const single = makeRegistry([OPUS]);
      expect(resolveModel("opus", single, { scope: scope(OPUS) })).toEqual(OPUS);
      expect(resolveModel("opus", single, { scope: scope(HAIKU) })).toEqual(OPUS);
    });

    it("lists the scoped set, not the full catalog, in a not-found refusal", () => {
      const message = resolveModel("nonexistent-model", registry, { scope: scope(SIMILAR_MODELS[0]) }) as string;
      expect(message).toContain("Accepted models:");
      expect(message).toContain("  anthropic/claude-sonnet-4-6");
      expect(message).not.toContain("anthropic/claude-haiku-4-5-20251001");
    });

    it("lists the scoped set in an ambiguity refusal", () => {
      const message = resolveModel("sonnet", registry, { scope: scope(SIMILAR_MODELS[0], SIMILAR_MODELS[1]) }) as string;
      expect(message).toContain('Model "sonnet" is ambiguous');
      expect(message).toContain("Accepted models:\n  anthropic/claude-sonnet-4-5-20241022\n  anthropic/claude-sonnet-4-6");
      expect(message).not.toContain("claude-haiku");
    });
  });
});

describe("describeModel", () => {
  it("gives a short label and a canonical id", () => {
    expect(describeModel({ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }))
      .toEqual({ modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6" });
  });

  it("falls back to the id when the model has no display name", () => {
    expect(describeModel({ provider: "openai-codex", id: "gpt-5.6-sol" }))
      .toEqual({ modelName: "gpt-5.6-sol", modelId: "openai-codex/gpt-5.6-sol" });
  });
});
