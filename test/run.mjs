// test/run.mjs — 用本地模拟 ComfyUI 服务做端到端测试（不占用真实显卡、不读取个人数据）
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shoot, fillTemplate } from "../lib/comfy.js";
import { apply, resolveOutputDir, skillProvider } from "../lib/index.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const state = { submitted: [], failNext: false, uploads: 0, deleted: [] };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = "";
  for await (const c of req) body += c;
  if (url.pathname === "/system_stats") return json({ system: {} });
  if (url.pathname === "/object_info/CheckpointLoaderSimple") {
    return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["modelA.safetensors", "modelB.safetensors"], {}] } } } });
  }
  if (url.pathname === "/upload/image") { state.uploads++; return json({ name: "ref_x.png", subfolder: "", type: "input" }); }
  if (url.pathname === "/queue") { state.deleted.push(JSON.parse(body)); return json({}); }
  if (url.pathname === "/prompt") {
    const id = `p${state.submitted.length + 1}`;
    state.submitted.push({ id, graph: JSON.parse(body).prompt, fail: state.failNext });
    state.failNext = false;
    return json({ prompt_id: id });
  }
  if (url.pathname.startsWith("/history/")) {
    const id = decodeURIComponent(url.pathname.slice(9));
    const job = state.submitted.find((j) => j.id === id);
    if (!job) return json({});
    if (job.fail) {
      return json({ [id]: { status: { status_str: "error", completed: false, messages: [["execution_error", { node_type: "KSampler", exception_message: "CUDA out of memory" }]] }, outputs: {} } });
    }
    return json({ [id]: { status: { status_str: "success", completed: true }, outputs: {
      "9": { images: [{ filename: "photographer_00001_.png", subfolder: "", type: "output" }] },
      "10": { images: [{ filename: "preview.png", subfolder: "", type: "temp" }] }
    } } });
  }
  if (url.pathname === "/view") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
  json({ error: "not found" }, 404);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const comfyUrl = `http://127.0.0.1:${server.address().port}`;
const tmp = await mkdtemp(join(tmpdir(), "photographer-test-"));
const base = { comfyUrl, width: 832, height: 1216, steps: 20, cfg: 5, sampler: "euler", scheduler: "normal" };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

try {
  await test("内置工作流：自动选模型、注入提示词、只保存 output 图", async () => {
    const out = join(tmp, "a");
    const r = await shoot({ ...base, prompt: "a cat", seed: 42, outputDir: out });
    assert.equal(r.images.length, 1);
    assert.equal(r.checkpoint, "modelA.safetensors");
    assert.deepEqual(await readFile(r.images[0]), PNG);
    const g = state.submitted.at(-1).graph;
    assert.equal(g["6"].inputs.text, "a cat");
    assert.equal(g["3"].inputs.seed, 42);
    assert.equal((await readdir(out)).length, 1);
  });

  await test("指定不存在的模型时报错", async () => {
    await assert.rejects(shoot({ ...base, prompt: "x", checkpoint: "nope.safetensors", outputDir: join(tmp, "b") }), /找不到模型/);
  });

  await test("ComfyUI 执行错误会原样上报，而不是等到超时", async () => {
    state.failNext = true;
    await assert.rejects(shoot({ ...base, prompt: "x", outputDir: join(tmp, "c"), timeoutMs: 5000 }), /CUDA out of memory/);
  });

  await test("自定义工作流：占位符保持数字类型并上传参考图", async () => {
    const wf = join(tmp, "wf.json");
    await writeFile(wf, JSON.stringify({
      "1": { class_type: "LoadImage", inputs: { image: "{{ref_image}}" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "photo, {{prompt}}" } },
      "3": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: "{{steps}}" } },
      "9": { class_type: "SaveImage", inputs: {} }
    }));
    const ref = join(tmp, "ref.png");
    await writeFile(ref, PNG);
    await shoot({ ...base, prompt: "a dog", seed: 7, workflowFile: wf, refImage: ref, outputDir: join(tmp, "d") });
    const g = state.submitted.at(-1).graph;
    assert.equal(g["2"].inputs.text, "photo, a dog");
    assert.equal(g["3"].inputs.seed, 7);
    assert.equal(g["3"].inputs.steps, 20);
    assert.equal(g["1"].inputs.image, "ref_x.png");
    assert.equal(state.uploads, 1);
  });

  await test("拒绝缺少 {{prompt}}、界面格式、未填占位符的工作流", async () => {
    const noPrompt = join(tmp, "np.json");
    await writeFile(noPrompt, JSON.stringify({ "1": { class_type: "CLIPTextEncode", inputs: { text: "fixed" } } }));
    await assert.rejects(shoot({ ...base, prompt: "x", workflowFile: noPrompt, outputDir: join(tmp, "e") }), /缺少 \{\{prompt\}\}/);
    const ui = join(tmp, "ui.json");
    await writeFile(ui, JSON.stringify({ nodes: [], links: [] }));
    await assert.rejects(shoot({ ...base, prompt: "x", workflowFile: ui, outputDir: join(tmp, "e") }), /界面格式/);
    const needsRef = join(tmp, "nr.json");
    await writeFile(needsRef, JSON.stringify({ "1": { class_type: "X", inputs: { a: "{{prompt}}", b: "{{ref_image}}" } } }));
    await assert.rejects(shoot({ ...base, prompt: "x", workflowFile: needsRef, outputDir: join(tmp, "e") }), /未填充的占位符/);
  });

  await test("参数校验：尺寸、空提示词、相对输出路径、非 http 地址", async () => {
    await assert.rejects(shoot({ ...base, prompt: "x", width: 1001, outputDir: tmp }), /8 的倍数/);
    await assert.rejects(shoot({ ...base, prompt: "  ", outputDir: tmp }), /提示词为空/);
    await assert.rejects(shoot({ ...base, prompt: "x", outputDir: "rel" }), /绝对路径/);
    await assert.rejects(shoot({ ...base, comfyUrl: "file:///etc/passwd", prompt: "x", outputDir: tmp }), /http\/https/);
  });

  await test("ComfyUI 未启动时给出可读错误", async () => {
    await assert.rejects(shoot({ ...base, comfyUrl: "http://127.0.0.1:1", prompt: "x", outputDir: tmp }), /无法连接 ComfyUI/);
  });

  await test("fillTemplate 不替换未知占位符", () => {
    assert.equal(fillTemplate("{{unknown}}", { a: 1 }), "{{unknown}}");
  });

  await test("输出目录：跟随会话工作区，绝不落在插件目录", () => {
    const ws = join(tmp, "ws");
    assert.ok(resolveOutputDir("", ws).startsWith(join(ws, "output", "photos")));
    assert.equal(resolveOutputDir("shots", ws), join(ws, "shots"));
    assert.ok(!resolveOutputDir("", undefined).includes("node_modules"));
  });

  await test("插件 apply：注册工具与技能，工具输出写入会话工作区", async () => {
    let tool; let provider;
    const ctx = {
      tools: { register: (t) => { tool = t; return () => {}; } },
      inject: (deps, fn) => fn({ skills: { registerProvider: (f) => { provider = f(); } } })
    };
    apply(ctx, { comfyUrl });
    assert.equal(tool.name, "photographer_shoot");
    assert.equal(provider, skillProvider);
    const listed = await provider.list();
    assert.equal(listed[0].name, "assistant-photographer");
    const skill = await provider.get();
    assert.ok(!skill.content.startsWith("---"), "正文应去掉 frontmatter");
    const ws = join(tmp, "session-ws");
    const out = await tool.execute({ prompt: "a tree" }, { agent: { session: { header: { cwd: ws } } } });
    assert.ok(out.images[0].startsWith(ws));
    assert.match(out.display, /^!\[成片\]\(</);
    await assert.rejects(tool.execute({ prompt: "x", workflow: "missing" }, {}), /未配置名为「missing」/);
  });

  console.log(`\n${passed} passed`);
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true });
}
