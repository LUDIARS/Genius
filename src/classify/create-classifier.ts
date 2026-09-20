import type { LoadedGeniusConfig } from "../config/types.js";
import type { DistillLlm } from "../distill/distill-llm.js";
import type { Classifier } from "./classifier.js";
import { DisclosureRoutedClassifier } from "./disclosure-routed-classifier.js";
import { JevClassifier } from "./jev-classifier.js";
import { TextLlmClassifier } from "./text-llm-classifier.js";

/**
 * 判定バックエンドを組む。
 *
 * 既定 (`distill-llm`) は Jev 導入前と同じ挙動 — カード内容はこのマシンから出ない。
 * `jev` を選んだときだけ外部バックエンドを足すが、実際に外へ出るのは
 * `disclosure: "public"` の判定に限られる (`DisclosureRoutedClassifier`)。
 *
 * API key が無いまま `jev` を選んだ場合、SDK が構築時に throw する。起動時に
 * 落とすのは意図的で、鍵が無いことに気付かないまま全件がローカルへ退避し続けて
 * 「Jev を使っているつもり」になる状態を作らない。
 */
export function createClassifier(config: LoadedGeniusConfig, llm: DistillLlm): Classifier {
  const local = new TextLlmClassifier(llm);
  if (config.classifier.backend !== "jev") return local;
  return new DisclosureRoutedClassifier({
    external: new JevClassifier({
      apiKey: config.classifier.apiKey,
      model: config.classifier.model,
      baseUrl: config.classifier.baseUrl,
      timeoutMs: config.classifier.timeoutMs,
    }),
    local,
  });
}
