const BASE_MODEL = {
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const FALLBACK_MODELS = [
  { ...BASE_MODEL, id: "big-pickle", name: "Big Pickle (free)" },
  { ...BASE_MODEL, id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash (free)" },
  { ...BASE_MODEL, id: "minimax-m2.5-free", name: "MiniMax M2.5 (free)", reasoning: false },
  { ...BASE_MODEL, id: "nemotron-3-super-free", name: "Nemotron 3 Super (free)" },
  { ...BASE_MODEL, id: "ring-2.6-1t-free", name: "Ring 2.6 1T (free)" },
];

const isFree = (id: string) => id.endsWith("-free") || id === "big-pickle";

export default function opencodePi(api: any) {
  const register = (models = FALLBACK_MODELS) => {
    const provider = {
      id: "opencode-pi",
      name: "OpenCode Zen Free",
      api: "opencode-pi-free",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "sk-noop",
      source: "bundled-extension:opencode-pi",
      models,
    };
    if (api?.registerProvider) api.registerProvider("opencode-pi", provider);
    else if (api?.providers?.register) api.providers.register(provider);
    return provider;
  };

  const provider = register();

  api?.on?.("session_start", async (_event: any, ctx: any) => {
    try {
      const res = await fetch("https://opencode.ai/zen/v1/models");
      if (!res.ok) return;
      const data = await res.json() as { data?: Array<{ id: string }> };
      const freeModels = (data.data ?? [])
        .filter((model) => isFree(model.id))
        .map((model) => ({
          ...BASE_MODEL,
          id: model.id,
          name: `${model.id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} (free)`,
        }));
      if (freeModels.length) {
        register(freeModels);
        ctx?.ui?.notify?.(`opencode-pi: loaded ${freeModels.length} free models from API`, "info");
      }
    } catch {}
  });

  return provider;
}
