// lib/comfy.js — 零依赖 ComfyUI HTTP 客户端（Node >= 22，使用内置 fetch / FormData）
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";

export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";
export const DEFAULT_NEGATIVE =
  "lowres, worst quality, low quality, jpeg artifacts, watermark, signature, text, bad anatomy, bad hands, extra fingers, missing fingers, deformed, blurry";

const REF_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const REF_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_SEED = 2 ** 47;

/** 只接受 http/https；去掉末尾斜杠与 URL 中的账号信息。 */
export function normalizeBaseUrl(url) {
  let u;
  try {
    u = new URL(String(url || DEFAULT_COMFY_URL));
  } catch {
    throw new Error(`ComfyUI 地址无效：${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`ComfyUI 地址必须是 http/https：${url}`);
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

async function request(base, path, { method = "GET", body, headers, timeoutMs = 15000, signal, as = "json" } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(base + path, { method, body, headers, signal: AbortSignal.any(signals) });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new Error(`连接 ComfyUI 超时：${method} ${path}`);
    if (err?.name === "AbortError") throw new Error("出图已取消");
    throw new Error(`无法连接 ComfyUI（${base}）：${err?.cause?.code || err?.message || err}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI ${method} ${path} 返回 HTTP ${res.status}${text ? `：${text.slice(0, 800)}` : ""}`);
  }
  if (as === "json") return res.json();
  if (as === "buffer") return Buffer.from(await res.arrayBuffer());
  return res.text();
}

export async function ping(base, opts = {}) {
  await request(base, "/system_stats", { timeoutMs: 5000, ...opts });
}

/** 兼容新旧两种 COMBO 声明格式。 */
export async function listCheckpoints(base, opts = {}) {
  const info = await request(base, "/object_info/CheckpointLoaderSimple", opts);
  const spec = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options.map(String);
  return [];
}

/** 内置 txt2img 工作流（API 格式），仅依赖 ComfyUI 核心节点。 */
export function buildDefaultWorkflow(v) {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: v.checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: v.width, height: v.height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: v.prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: v.negative, clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: v.seed, steps: v.steps, cfg: v.cfg,
        sampler_name: v.sampler, scheduler: v.scheduler, denoise: 1,
        model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0]
      }
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "photographer", images: ["8", 0] } }
  };
}

/** 递归替换 {{token}}；整串恰为单个占位符时保留原类型（数字不会被转成字符串）。 */
export function fillTemplate(node, vars) {
  if (typeof node === "string") {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole && Object.hasOwn(vars, whole[1])) return vars[whole[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  }
  if (Array.isArray(node)) return node.map((n) => fillTemplate(n, vars));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, val]) => [k, fillTemplate(val, vars)]));
  }
  return node;
}

export async function loadWorkflowTemplate(file) {
  if (!isAbsolute(file)) throw new Error(`工作流路径必须是绝对路径：${file}`);
  let graph;
  try {
    graph = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`读取工作流失败（${basename(file)}）：${err.message}`);
  }
  if (Array.isArray(graph?.nodes)) {
    throw new Error(`「${basename(file)}」是 ComfyUI 界面格式；请在 ComfyUI 中用「导出 (API)」重新导出`);
  }
  const nodes = Object.values(graph ?? {});
  if (!nodes.length || !nodes.every((n) => n && typeof n.class_type === "string")) {
    throw new Error(`「${basename(file)}」不是 ComfyUI API 格式工作流`);
  }
  const raw = JSON.stringify(graph);
  if (!raw.includes("{{prompt}}")) {
    throw new Error(`「${basename(file)}」缺少 {{prompt}} 占位符，提示词无法注入`);
  }
  return graph;
}

async function uploadRefImage(base, file, opts) {
  if (!isAbsolute(file)) throw new Error(`参考图必须是绝对路径：${file}`);
  const ext = extname(file).toLowerCase();
  if (!REF_IMAGE_EXTS.has(ext)) throw new Error(`参考图格式不支持：${ext || "无扩展名"}`);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`参考图不存在：${file}`);
  if (info.size > REF_IMAGE_MAX_BYTES) throw new Error("参考图超过 20MB");
  const form = new FormData();
  form.append("image", new Blob([await readFile(file)]), `ref_${randomUUID().slice(0, 8)}${ext}`);
  form.append("type", "input");
  const res = await request(base, "/upload/image", { method: "POST", body: form, timeoutMs: 60000, ...opts });
  return res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
}

function executionError(item) {
  const msgs = (item?.status?.messages ?? [])
    .filter(([type]) => type === "execution_error")
    .map(([, d]) => `${d?.node_type ?? "节点"}: ${d?.exception_message ?? "未知错误"}`.trim());
  return msgs.join("；") || "ComfyUI 执行失败（未返回错误详情）";
}

async function waitForResult(base, promptId, { timeoutMs, signal, pollMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("出图已取消");
    const hist = await request(base, `/history/${encodeURIComponent(promptId)}`, { signal }).catch((err) => {
      if (err.message === "出图已取消") throw err;
      return null; // 短暂网络抖动时继续轮询
    });
    const item = hist?.[promptId];
    if (item) {
      if (item.status?.status_str === "error") throw new Error(executionError(item));
      if (item.status?.completed || (item.outputs && Object.keys(item.outputs).length)) return item;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // 超时后尽量把任务移出队列，避免后台继续占用显卡
  await request(base, "/queue", {
    method: "POST", body: JSON.stringify({ delete: [promptId] }),
    headers: { "Content-Type": "application/json" }
  }).catch(() => {});
  throw new Error(`等待 ComfyUI 出图超时（${Math.round(timeoutMs / 1000)} 秒）`);
}

const safeName = (s) => basename(String(s)).replace(/[^\w.\-]+/g, "_").slice(0, 120) || "image.png";

async function saveOutputs(base, item, outDir, opts) {
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  const saved = [];
  for (const out of Object.values(item.outputs ?? {})) {
    for (const img of out.images ?? []) {
      if (img.type && img.type !== "output") continue; // 跳过预览/临时图
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
      const buf = await request(base, `/view?${q}`, { as: "buffer", timeoutMs: 60000, ...opts });
      const target = join(outDir, `${stamp}_${saved.length + 1}_${safeName(img.filename)}`);
      await writeFile(target, buf, { flag: "wx" });
      saved.push(target);
    }
  }
  if (!saved.length) throw new Error("ComfyUI 执行完成，但工作流没有 SaveImage 输出");
  return saved;
}

/**
 * 完整出图流程：健康检查 → 组装工作流 → 提交 → 轮询 → 下载落盘。
 * @returns {{ images: string[], promptId: string, seconds: number, checkpoint?: string, seed: number }}
 */
export async function shoot(o, { signal } = {}) {
  const base = normalizeBaseUrl(o.comfyUrl);
  const prompt = String(o.prompt ?? "").trim();
  if (!prompt) throw new Error("提示词为空");
  if (!o.outputDir || !isAbsolute(o.outputDir)) throw new Error("outputDir 必须是绝对路径");
  for (const [k, val] of [["width", o.width], ["height", o.height]]) {
    if (!Number.isInteger(val) || val < 256 || val > 2048 || val % 8) throw new Error(`${k} 需为 256~2048 之间的 8 的倍数`);
  }
  const t0 = Date.now();
  await ping(base, { signal });

  const seed = Number.isInteger(o.seed) && o.seed >= 0 ? o.seed : randomInt(0, MAX_SEED);
  const vars = {
    prompt,
    negative: String(o.negative ?? "").trim() || DEFAULT_NEGATIVE,
    seed, width: o.width, height: o.height,
    steps: o.steps, cfg: o.cfg, sampler: o.sampler, scheduler: o.scheduler
  };

  let graph;
  let checkpoint;
  if (o.workflowFile) {
    const template = await loadWorkflowTemplate(o.workflowFile);
    if (o.refImage) vars.ref_image = await uploadRefImage(base, o.refImage, { signal });
    if (o.checkpoint) vars.checkpoint = o.checkpoint;
    graph = fillTemplate(template, vars);
    const left = [...new Set(JSON.stringify(graph).match(/\{\{\w+\}\}/g) ?? [])];
    if (left.length) throw new Error(`工作流仍有未填充的占位符：${left.join(", ")}`);
  } else {
    if (o.refImage) throw new Error("内置工作流不支持参考图；请在设置中配置带 {{ref_image}} 的自定义工作流");
    const available = await listCheckpoints(base, { signal });
    checkpoint = o.checkpoint || available[0];
    if (!checkpoint) throw new Error("ComfyUI 中没有可用的 Checkpoint 模型");
    if (available.length && !available.includes(checkpoint)) {
      throw new Error(`ComfyUI 中找不到模型「${checkpoint}」`);
    }
    graph = buildDefaultWorkflow({ ...vars, checkpoint });
  }

  const queued = await request(base, "/prompt", {
    method: "POST",
    body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
    headers: { "Content-Type": "application/json" },
    signal
  });
  if (!queued?.prompt_id) throw new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(queued).slice(0, 500)}`);

  const item = await waitForResult(base, queued.prompt_id, { timeoutMs: o.timeoutMs ?? 600000, signal });
  const images = await saveOutputs(base, item, o.outputDir, { signal });
  return { images, promptId: queued.prompt_id, seconds: Math.round((Date.now() - t0) / 100) / 10, checkpoint, seed };
}
