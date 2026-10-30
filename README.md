# dsh-assistant-photographer

DeepSeek Harness（DSH）的助理摄影师插件：先和你商量景别、机位、穿搭、光影和提示词，确认后再通过 ComfyUI 出图；可以按角色档案保持人物外观一致。

## 功能

- **两阶段流程**：讨论方案时不出图；你说「开拍」后才调用 `photographer_shoot` 工具。工具没有返回成功时，模型不会声称已经出图。
- **角色一致性**：按「面部与发型 / 体型 / 标志性配饰与遮挡规则 / 专属负向词」四层整理角色设定，换装换景时保持人物不变。没有指定角色时不套用任何固定外貌。
- **ComfyUI 直连**：内置只依赖核心节点的文生图工作流；也可以配置自己的 API 格式工作流（支持参考图）。
- **无额外运行时**：纯 Node.js 实现，不需要 Python，不写入插件目录以外的配置。

## 前置条件

- DSH 0.2.x（开发时使用 0.2.1-rc.2）
- 可访问的 ComfyUI 服务（默认 `http://127.0.0.1:8188`），且至少装有一个 Checkpoint 模型

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-assistant-photographer
```

本地开发时安装源码目录：

```sh
dsh plugin --profile <你的 profile> add link:/path/to/dsh-assistant-photographer
```

安装后重启 DSH。技能中心会出现 `assistant-photographer`，工具列表会出现 `photographer_shoot`。

## 使用

> 帮我构思一组秋天窗边看书的写真，暖色侧光。

助理摄影师会给出机位、穿搭、光线建议和提示词草案。满意后回复「开拍」，成片会显示在对话中，并保存到当前工作区的 `output/photos/<日期>/`。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI 地址。提示词和参考图会发送到这里，远程地址请确认可信 |
| `outputDir` | 空 | 留空 = 工作区下 `output/photos/<日期>`；相对路径相对工作区 |
| `checkpoint` | 空 | 内置工作流使用的模型；留空自动使用第一个 |
| `steps` / `cfg` / `sampler` / `scheduler` | `25` / `5` / `euler_ancestral` / `normal` | 内置工作流采样参数 |
| `workflows` | `{}` | 自定义工作流：名称 → API 格式 JSON 绝对路径 |
| `timeoutSeconds` | `600` | 单次出图超时 |

### 自定义工作流

1. 在 ComfyUI 中搭好工作流，用「导出 (API)」保存为 JSON（界面格式无法使用）。
2. 把需要注入的位置改成占位符：必须有 `{{prompt}}`；可选 `{{negative}}`、`{{seed}}`、`{{width}}`、`{{height}}`、`{{steps}}`、`{{cfg}}`、`{{checkpoint}}`、`{{ref_image}}`（参考图会自动上传到 ComfyUI）。
3. 在 `workflows` 中添加 `"名称": "JSON 绝对路径"`，对话中说「用 名称 工作流拍」即可。

参考写法见 [`examples/workflow_api.example.json`](examples/workflow_api.example.json)。

### 角色档案

格式参考 [`skills/assistant-photographer/character_profile.template.json`](skills/assistant-photographer/character_profile.template.json)。可以在对话中直接描述角色，也可以让助理摄影师读取你填写好的档案文件。

## 命令行调试

```sh
npx dsh-photographer-shoot --prompt "a portrait by the window, soft light" --comfy-url http://127.0.0.1:8188
```

## 内容边界

不生成未成年人的性暗示内容；不生成可识别真实人物的裸露或误导性照片。请遵守所用模型的许可协议。

## 许可证

[MIT](LICENSE)
