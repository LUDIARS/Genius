import type { LoadedGeniusConfig } from "../config/types.js";
import { ClaudeCliDistillLlm } from "./claude-cli-llm.js";
import type { DistillLlm } from "./distill-llm.js";
import { OllamaDistillLlm } from "./ollama-llm.js";

export function createDistillLlm(config: LoadedGeniusConfig): DistillLlm {
  if (config.distill.backend === "ollama") {
    return new OllamaDistillLlm({
      baseUrl: config.embedding.baseUrl,
      model: config.distill.ollamaModel,
    });
  }
  return new ClaudeCliDistillLlm({
    model: config.distill.model,
    sensitiveCheckModel: config.distill.sensitiveCheckModel,
  });
}
