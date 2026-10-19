/**
 * `fsdt import`：从设计图提取字段候选。
 *
 * 关键设计：**这个命令默认不写 IR**。
 *
 * 它输出候选 JSON（含 confidence 与 evidence），由人或 AI agent 审阅后，
 * 再用 `fsdt import apply` 把决策写回去。看起来多了一步，但这一步正是
 * 整个导入子系统的价值所在——自动写入的错误字段会被下游一路放大。
 *
 * `--apply` 存在，但它要求同时给出**显式决策**，不接受「全都接受」。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyDecisions,
  createFigmaExtractor,
  createVisionExtractor,
  type Decision,
  type ExtractionResult,
} from '@fsdt/importer';
import { saveIR } from '@fsdt/core-ir';
import { flagBool, flagList, flagString, rejectUnknown, type ParsedArgs } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT_OK, UsageError, rel } from '../io.js';
import { findIr, loadIrFrom } from '../ir-source.js';

const ALLOWED = ['ir', 'out', 'file', 'node', 'token', 'apply', 'decisions', 'node-id', 'width', 'height', 'help'];

/**
 * 兼容 OpenAI Chat Completions 的视觉调用。
 *
 * 为什么不在 CLI 里直接引某家的 SDK：导入包刻意不绑 provider（见 importer/vision.ts），
 * CLI 也不该绑。用「OpenAI 兼容协议」这一层做适配，能覆盖绝大多数国内外的
 * 视觉模型网关（它们几乎都提供 `/chat/completions` 兼容端点）。
 *
 * 需要的环境变量：
 * - `FSDT_VISION_API_KEY`   必填
 * - `FSDT_VISION_BASE_URL`  默认 `https://api.openai.com/v1`
 * - `FSDT_VISION_MODEL`     默认 `gpt-4o-mini`
 */
function createOpenAiCompatibleCaller(
  apiKey: string,
  ctx: CommandContext,
): (input: { imageBase64: string; prompt: string; mimeType: string }) => Promise<unknown> {
  const baseUrl = ctx.envOf('FSDT_VISION_BASE_URL') ?? 'https://api.openai.com/v1';
  const model = ctx.envOf('FSDT_VISION_MODEL') ?? 'gpt-4o-mini';
  return async (input) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        // 要求 JSON 输出（vision 通道的校验层仍会二次把关，这里只是提高命中率）
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new UsageError(`视觉模型调用失败：${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content;
    if (text === undefined) throw new UsageError('视觉模型返回中没有 content 字段');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UsageError('视觉模型返回的不是合法 JSON（prompt 里的 json 约束可能被模型忽略了）');
    }
  };
}

export async function runImportCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const unknown = rejectUnknown(args, ALLOWED);
  if (unknown.length > 0) throw new UsageError(unknown.join('\n'));

  const channel = args.positionals[0];
  if (channel === 'apply') return runApply(args, ctx);
  if (channel !== 'figma' && channel !== 'image') {
    throw new UsageError('用法：fsdt import figma --file <key> [--node <id>...] ｜ fsdt import image --file <png> ｜ fsdt import apply --decisions <json>');
  }

  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir } = await loadIrFrom(source);
  void ir;

  let extraction: ExtractionResult;
  if (channel === 'figma') {
    const fileKey = flagString(args, 'file');
    if (fileKey === undefined) throw new UsageError('figma 导入需要 --file <fileKey>');
    // 密钥只从环境变量读：写进命令行会进 shell history 与 CI 日志
    const token = flagString(args, 'token') ?? ctx.envOf('FSDT_FIGMA_TOKEN');
    if (token === undefined) {
      throw new UsageError('缺少 Figma token：请设置环境变量 FSDT_FIGMA_TOKEN（不要用 --token，它会留在 shell history 里）');
    }
    extraction = await createFigmaExtractor().extract({
      channel: 'figma',
      fileKey,
      nodeIds: flagList(args, 'node'),
      token,
    });
  } else {
    const imagePath = flagString(args, 'file');
    if (imagePath === undefined) throw new UsageError('image 导入需要 --file <图片路径>');
    const apiKey = ctx.envOf('FSDT_VISION_API_KEY');
    if (apiKey === undefined) {
      throw new UsageError('缺少视觉模型密钥：请设置环境变量 FSDT_VISION_API_KEY');
    }
    // 视觉模型的具体 provider 由应用层决定，CLI 这里只给出「怎么调」的适配点。
    // 刻意不内置 SDK：那会把 CLI 绑死在某一家模型上。
    const imageBase64 = await readFile(join(ctx.cwd, imagePath)).then((b) => b.toString('base64'));
    extraction = await createVisionExtractor({
      imageWidth: Number(flagString(args, 'width') ?? 1440),
      imageHeight: Number(flagString(args, 'height') ?? 900),
      callModel: createOpenAiCompatibleCaller(apiKey, ctx),
    }).extract({ channel: 'vision', imagePath });
  }

  for (const warning of extraction.warnings) ctx.io.stderr(`⚠ ${warning}`);

  const payload = `${JSON.stringify(extraction, null, 2)}\n`;
  const out = flagString(args, 'out');
  if (out === undefined) {
    ctx.io.stdout(payload);
    ctx.io.stderr(
      `共 ${extraction.candidates.length} 条候选（${extraction.candidates.filter((c) => c.confidence >= 0.7).length} 条置信度 ≥0.7）。` +
        '审阅后执行：fsdt import apply --decisions <decisions.json>',
    );
    return EXIT_OK;
  }
  const path = join(ctx.cwd, out);
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, payload, 'utf8');
  ctx.io.stderr(`✓ 候选已写入 ${rel(ctx.cwd, path)}（未改动 IR）`);
  return EXIT_OK;
}

async function runApply(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const source = findIr(ctx.cwd, flagString(args, 'ir'));
  const { ir } = await loadIrFrom(source);
  // 先检查 --apply 再检查 --decisions：这是「确认」而不是「参数」，
  // 用户最可能漏的就是它，所以优先报它（否则他会补上 --decisions 再来一次才发现还差 --apply）
  if (!flagBool(args, 'apply')) {
    throw new UsageError('apply 子命令需要显式 --apply 确认（防止误把候选批量写入 IR）');
  }
  const decisionsPath = flagString(args, 'decisions');
  if (decisionsPath === undefined) throw new UsageError('apply 需要 --decisions <json 文件>');

  const raw = JSON.parse(await readFile(join(ctx.cwd, decisionsPath), 'utf8')) as {
    candidates: ExtractionResult['candidates'];
    decisions: Decision[];
    target: { mode: 'existing' | 'new'; nodeId?: string; name?: string; dbName?: string };
  };

  const result = applyDecisions(
    ir,
    { candidates: raw.candidates, groups: [], pages: [], warnings: [] },
    raw.decisions,
    raw.target,
  );
  await saveIR(source.path, result.ir);
  ctx.io.stderr(`✓ 新增 ${result.added} 个字段，跳过 ${result.skipped} 个（已存在），目标节点 ${result.nodeId}`);
  for (const w of result.warnings) ctx.io.stderr(`⚠ ${w}`);
  return EXIT_OK;
}
