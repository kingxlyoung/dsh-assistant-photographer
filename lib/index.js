// lib/index.js — DSH 助理摄影师插件入口
// · 注册 photographer_shoot 工具（必需服务：tools）
// · 以 skill provider 方式注册包内技能（可选服务：skills；不写入用户目录）
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "schemastery";
import { DEFAULT_COMFY_URL, shoot } from "./comfy.js";

export const name = "assistant-photographer";
export const inject = ["tools"];

export const Config = z.object({
  comfyUrl: z.string().default(DEFAULT_COMFY_URL)
    .description("ComfyUI 地址。注意：提示词与参考图会发送到该地址，填写远程地址前请确认其可信"),
  outputDir: z.string().default("")
    .description("成片保存目录。留空 = 当前会话工作区下 output/photos/<日期>；相对路径相对会话工作区"),
  checkpoint: z.string().default("")
    .description("内置工作流使用的 Checkpoint 文件名；留空自动使用 ComfyUI 中的第一个"),
  steps: z.number().min(1).max(150).step(1).default(25).description("内置工作流采样步数"),
  cfg: z.number().min(0).max(30).step(0.1).default(5).description("内置工作流 CFG"),
  sampler: z.string().default("euler_ancestral").description("内置工作流采样器"),
  scheduler: z.string().default("normal").description("内置工作流调度器"),
  workflows: z.dict(z.string()).default({})
    .description("自定义工作流：名称 → API 格式 JSON 的绝对路径。必须含 {{prompt}}，可用 {{negative}} {{seed}} {{width}} {{height}} {{steps}} {{cfg}} {{checkpoint}} {{ref_image}}"),
  timeoutSeconds: z.number().min(30).max(3600).step(1).default(600).description("单次出图超时（秒），首次加载模型较慢")
});

const DEFAULTS = {
  comfyUrl: DEFAULT_COMFY_URL, outputDir: "", checkpoint: "", steps: 25, cfg: 5,
  sampler: "euler_ancestral", scheduler: "normal", workflows: {}, timeoutSeconds: 600
};

// ---- 技能：按 dsh-novel-writer 同款 provider 方式注册，宿主无 skills 服务时静默跳过 ----
const SKILL_NAME = "assistant-photographer";
const SKILL_DESCRIPTION =
  "助理摄影师：先与用户商量景别、机位、穿搭、光影并给出提示词草案，用户确认后再调用 photographer_shoot 经 ComfyUI 出图；支持按角色档案锁定人物外观。";
const SKILL_WHEN_TO_USE =
  "用户想拍照、拍写真、构思摄影分镜、为某个角色生成照片，或提到「助理摄影师」「开拍」时；纯闲聊不使用";
const SKILL_DIR_URL = new URL("../skills/assistant-photographer/", import.meta.url);
const SKILL_BODY_URL = new URL("SKILL.md", SKILL_DIR_URL);
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true };
const SKILL_RESOURCE_BASE = { kind: "directory", path: fileURLToPath(SKILL_DIR_URL) };

function stripFrontmatter(markdown) {
  const text = String(markdown);
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4).replace(/^\s*\n/, "");
}

const skillMeta = {
  name: SKILL_NAME, description: SKILL_DESCRIPTION, whenToUse: SKILL_WHEN_TO_USE,
  invocation: SKILL_INVOCATION, source: "custom", provider: name, resourceBase: SKILL_RESOURCE_BASE
};

export const skillProvider = {
  name,
  list: () => Promise.resolve([{ ...skillMeta, rank: 600, locator: SKILL_BODY_URL }]),
  async get() {
    return { ...skillMeta, content: stripFrontmatter(await readFile(SKILL_BODY_URL, "utf8")) };
  }
};

// ---- 工具 ----
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 输出目录绝不落在插件包（node_modules）内。 */
export function resolveOutputDir(configured, sessionCwd) {
  const workspace = sessionCwd && isAbsolute(sessionCwd)
    ? sessionCwd
    : join(homedir(), ".dsh", "assistant-photographer");
  if (!configured) return join(workspace, "output", "photos", today());
  return isAbsolute(configured) ? configured : resolve(workspace, configured);
}

function intOrUndefined(v) {
  return Number.isInteger(v) ? v : undefined;
}

export function createShootTool(getConfig) {
  return {
    name: "photographer_shoot",
    description:
      "【助理摄影师出图】仅在用户已确认拍摄方案、或明确要求直接出图时调用；方案讨论阶段不要调用。经 ComfyUI 生成图片并保存到本地，返回图片绝对路径。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "最终定稿的正向提示词" },
        negative: { type: "string", description: "负向提示词；留空使用通用默认值" },
        width: { type: "integer", description: "宽度，256~2048 且为 8 的倍数，默认 832" },
        height: { type: "integer", description: "高度，256~2048 且为 8 的倍数，默认 1216" },
        seed: { type: "integer", description: "随机种子；省略则随机" },
        workflow: { type: "string", description: "使用的自定义工作流名称（来自插件设置）；省略使用内置工作流" },
        ref_image: { type: "string", description: "参考图绝对路径；仅自定义工作流含 {{ref_image}} 时可用" }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    async execute(args, exec) {
      const cfg = { ...DEFAULTS, ...getConfig() };
      let workflowFile;
      if (args?.workflow) {
        workflowFile = cfg.workflows?.[args.workflow];
        if (!workflowFile) {
          const names = Object.keys(cfg.workflows ?? {});
          throw new Error(`未配置名为「${args.workflow}」的工作流。可用：${names.join("、") || "（无，仅内置工作流）"}`);
        }
      }
      const result = await shoot({
        comfyUrl: cfg.comfyUrl,
        prompt: args?.prompt,
        negative: args?.negative,
        width: intOrUndefined(args?.width) ?? 832,
        height: intOrUndefined(args?.height) ?? 1216,
        seed: intOrUndefined(args?.seed),
        steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler,
        checkpoint: cfg.checkpoint || undefined,
        workflowFile,
        refImage: args?.ref_image || undefined,
        outputDir: resolveOutputDir(cfg.outputDir, exec?.agent?.session?.header?.cwd),
        timeoutMs: cfg.timeoutSeconds * 1000
      }, { signal: exec?.signal });
      return {
        images: result.images,
        seconds: result.seconds,
        seed: result.seed,
        ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
        display: result.images.map((p) => `![成片](<${p}>)`).join("\n")
      };
    }
  };
}

export function apply(ctx, config = {}) {
  const tool = createShootTool(() => config ?? {});
  if (typeof ctx.effect === "function") {
    ctx.effect(() => ctx.tools.register(tool), "assistant-photographer: photographer_shoot tool");
  } else {
    ctx.tools.register(tool);
  }

  ctx.inject?.(["skills"], (sctx) => {
    if (!sctx?.skills || typeof sctx.skills.registerProvider !== "function") return;
    try {
      sctx.skills.registerProvider(() => skillProvider);
    } catch (err) {
      console.warn("[dsh-assistant-photographer] skill provider registration failed:", err?.message ?? err);
    }
  });
}
