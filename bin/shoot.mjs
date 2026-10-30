#!/usr/bin/env node
// 命令行出图（调试 / 无插件环境使用）。输出单行 JSON。
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_COMFY_URL, shoot } from "../lib/comfy.js";

const { values: a } = parseArgs({
  options: {
    prompt: { type: "string" },
    negative: { type: "string" },
    width: { type: "string", default: "832" },
    height: { type: "string", default: "1216" },
    seed: { type: "string" },
    steps: { type: "string", default: "25" },
    cfg: { type: "string", default: "5" },
    sampler: { type: "string", default: "euler_ancestral" },
    scheduler: { type: "string", default: "normal" },
    checkpoint: { type: "string" },
    workflow: { type: "string" },
    "ref-image": { type: "string" },
    "comfy-url": { type: "string" },
    "output-dir": { type: "string", default: "output/photos" },
    timeout: { type: "string", default: "600" },
    help: { type: "boolean", short: "h" }
  }
});

if (a.help || !a.prompt) {
  console.log(`用法: dsh-photographer-shoot --prompt "<提示词>" [--negative ..] [--width 832] [--height 1216]
  [--seed N] [--checkpoint 文件名] [--workflow <API 工作流绝对路径>] [--ref-image <绝对路径>]
  [--comfy-url ${DEFAULT_COMFY_URL}] [--output-dir output/photos] [--timeout 600]
ComfyUI 地址优先级：--comfy-url > 环境变量 COMFYUI_URL > ${DEFAULT_COMFY_URL}`);
  process.exit(a.help ? 0 : 1);
}

const num = (s) => (s === undefined ? undefined : Number(s));
try {
  const r = await shoot({
    comfyUrl: a["comfy-url"] || process.env.COMFYUI_URL || DEFAULT_COMFY_URL,
    prompt: a.prompt, negative: a.negative,
    width: num(a.width), height: num(a.height), seed: num(a.seed),
    steps: num(a.steps), cfg: num(a.cfg), sampler: a.sampler, scheduler: a.scheduler,
    checkpoint: a.checkpoint,
    workflowFile: a.workflow ? resolve(a.workflow) : undefined,
    refImage: a["ref-image"] ? resolve(a["ref-image"]) : undefined,
    outputDir: resolve(a["output-dir"]),
    timeoutMs: num(a.timeout) * 1000
  });
  console.log(JSON.stringify({ status: "success", ...r }));
} catch (err) {
  console.log(JSON.stringify({ status: "error", message: err.message }));
  process.exit(1);
}
