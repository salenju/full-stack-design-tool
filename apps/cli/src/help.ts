/**
 * 帮助文本。
 *
 * 原则：**每条命令都给出一个能直接粘进终端跑的例子**。
 * CLI 的首要消费者除了人还有 AI agent——agent 从 `--help` 里学到的
 * 就是它之后会用到的调用形式，含糊的描述会让它去猜参数名。
 */

export const CLI_NAME = 'fsdt';

export interface CommandDoc {
  name: string;
  summary: string;
  usage: string;
  options: Array<{ flag: string; desc: string }>;
  example: string;
  /** 是否需要 design/ir.json */
  needsIr: boolean;
}

export const COMMANDS: CommandDoc[] = [
  {
    name: 'init',
    summary: '在仓库内初始化 design/（文件模式），生成空 IR',
    usage: 'fsdt init [--name <项目名>] [--force]',
    options: [
      { flag: '--name <名>', desc: '项目名，默认取目录名' },
      { flag: '--force', desc: '覆盖已存在的 ir.json（危险）' },
    ],
    example: 'fsdt init --name 设备管理平台',
    needsIr: false,
  },
  {
    name: 'compile',
    summary: 'IR → OpenAPI / UI Schema / 示例数据（默认输出到 stdout，不写盘）',
    usage: 'fsdt compile [--format yaml|json] [--out <dir>] [--stdout] [--seed <n>] [--rows <n>]',
    options: [
      { flag: '--format yaml|json', desc: 'OpenAPI 序列化格式，默认 yaml' },
      { flag: '--out <dir>', desc: '写盘到目录（openapi / ui-schema / seed）' },
      { flag: '--stdout', desc: '输出自包含 JSON 包（供 AI agent 消费）' },
      { flag: '--seed <n>', desc: '示例数据随机种子' },
      { flag: '--rows <n>', desc: '每表行数，默认 5' },
    ],
    example: 'fsdt compile --stdout json | jq .openapi.document',
    needsIr: true,
  },
  {
    name: 'lint',
    summary: '跑契约规则检查，三种输出格式',
    usage:
      'fsdt lint [--format text|json|sarif] [--fail-on error|warn|info|none] [--only <规则>] [--except <规则>] [--fix]',
    options: [
      { flag: '--format', desc: 'text（人看）| json（脚本）| sarif（GitHub Code Scanning）' },
      { flag: '--fail-on', desc: '达到该级别即退出码 1，默认 error' },
      { flag: '--only <L00x>', desc: '只跑指定规则，可重复或逗号分隔' },
      { flag: '--except <L00x>', desc: '跳过指定规则' },
      { flag: '--fix', desc: '应用可自动修复的问题并写回 IR（枚举取值等无法推断的会跳过）' },
    ],
    example: 'fsdt lint --fix',
    needsIr: true,
  },
  {
    name: 'gen',
    summary: 'IR → Vue 前端 + NestJS 后端代码（默认只预览）',
    usage: 'fsdt gen [--target vue,nestjs] [--out <dir>] [--check] [--force] [--skip-verify]',
    options: [
      { flag: '--target', desc: 'vue | nestjs，默认两者' },
      { flag: '--out <dir>', desc: '实际写盘；不给则只列出将生成的文件' },
      { flag: '--check', desc: '漂移检测：产物与画布不一致时退出码 1（与 --out 互斥）' },
      { flag: '--force', desc: '覆盖手改过的文件' },
      { flag: '--skip-verify', desc: '跳过生成前的 IR 语义校验与 Lint error 门禁' },
    ],
    example: 'fsdt gen --out ./output',
    needsIr: true,
  },
  {
    name: 'sample',
    summary: '生成示例数据（确定性，同 seed 同结果）',
    usage: 'fsdt sample [--seed <n>] [--rows <n>] [--out <dir>] [--format json|http|postman|sql]',
    options: [
      { flag: '--seed <n>', desc: '随机种子，默认取 IR 里的 settings' },
      { flag: '--rows <n>', desc: '每表行数' },
      { flag: '--out <dir>', desc: '写盘：每表一个 JSON + index.ts，以及所选格式的文件' },
      { flag: '--format <f>', desc: 'json（默认）| http（REST Client）| postman（v2.1）| sql（INSERT），可重复' },
      { flag: '--base-url <url>', desc: 'http / postman 里的服务地址，默认 http://localhost:3000' },
    ],
    example: 'fsdt sample --rows 20 --out ./mocks --format http --format postman --format sql',
    needsIr: true,
  },
  {
    name: 'export',
    summary: '画布导出为 svg / png / mermaid / drawio / json / figma 脚本',
    usage: 'fsdt export [--format <列表>] [--canvas <id|名>] [--out <dir>] [--theme light|dark] [--scale <n>] [--notes] [--ports]',
    options: [
      { flag: '--format', desc: '可用逗号分隔多个，默认 svg' },
      { flag: '--canvas', desc: '画布 ID 或名称，不给则导出全部画布' },
      { flag: '--theme', desc: 'light | dark' },
      { flag: '--scale', desc: 'png 缩放，默认 2' },
      { flag: '--notes', desc: '包含备注节点' },
      { flag: '--ports', desc: '标注字段级端口' },
    ],
    example: 'fsdt export --format svg,png --out ./docs/diagrams',
    needsIr: true,
  },
  {
    name: 'import',
    summary: '从 Figma / 设计图提取字段候选（默认不写 IR，需人工确认后 apply）',
    usage: 'fsdt import figma --file <key> [--node <id>…] | fsdt import image --file <png> | fsdt import apply --decisions <json> --apply',
    options: [
      { flag: '--file', desc: 'figma: fileKey；image: 图片路径' },
      { flag: '--node <id>', desc: 'Figma 节点 ID，可重复或逗号分隔' },
      { flag: '--out <path>', desc: '候选 JSON 落盘位置（默认 stdout）' },
      { flag: '--decisions <json>', desc: 'apply 时的决策文件' },
      { flag: '--apply', desc: 'apply 子命令的显式确认（防误写 IR）' },
    ],
    example: 'FSDT_FIGMA_TOKEN=xxx fsdt import figma --file FILEKEY --out candidates.json',
    needsIr: true,
  },
  {
    name: 'diff',
    summary: 'IR 语义 diff（不是文本 diff，坐标变化不算变化）',
    usage: 'fsdt diff --from <path> [--format text|json]',
    options: [
      { flag: '--from <path>', desc: '基线 IR 文件；git ref 请先导出到临时文件' },
      { flag: '--format', desc: 'text | json' },
    ],
    example: 'git show HEAD~1:design/ir.json > /tmp/base.json && fsdt diff --from /tmp/base.json',
    needsIr: true,
  },
];

export function globalHelp(): string {
  const lines = [
    `${CLI_NAME} — 全栈全链路设计工具命令行`,
    '',
    '用法：',
    `  ${CLI_NAME} <命令> [选项]`,
    '',
    '命令：',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(9)} ${c.summary}`),
    '',
    '全局选项：',
    '  --ir <path>   显式指定 IR 文件（默认向上查找 design/ir.json）',
    '  -h, --help    显示帮助',
    '  -v, --version 显示版本',
    '',
    '退出码：0 成功 / 1 校验失败或存在差异 / 2 用法错误',
    '',
    `查看某命令详情：${CLI_NAME} <命令> --help`,
  ];
  return `${lines.join('\n')}\n`;
}

export function commandHelp(doc: CommandDoc): string {
  const lines = [
    `${CLI_NAME} ${doc.name} — ${doc.summary}`,
    '',
    '用法：',
    `  ${doc.usage}`,
    '',
    '选项：',
    ...doc.options.map((o) => `  ${o.flag.padEnd(28)} ${o.desc}`),
    '  --ir <path>'.padEnd(30) + '指定 IR 文件',
    '',
    '示例：',
    `  ${doc.example}`,
  ];
  return `${lines.join('\n')}\n`;
}

export const VERSION = '0.1.0';
