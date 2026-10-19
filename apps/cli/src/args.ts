/**
 * 极简参数解析。
 *
 * 刻意不引 commander / yargs：CLI 是「AI agent 的工具面」（TD 16.1），
 * 它的参数行为必须**可预测且无隐式规则**。第三方解析器会替你做一堆决定
 * （自动 camelCase、自动展开 `--no-x`、未知参数静默忽略），而这些正是
 * agent 调用出错时最难排查的地方——参数写错了，工具却正常退出。
 *
 * 这里只做三件事：
 * 1. `--key value` / `--key=value` / `--flag`（布尔）；
 * 2. 重复的 key 收集成数组（如 `--target vue --target nestjs` 与 `--target vue,nestjs` 等价）；
 * 3. 未知参数由各命令自己报错（退出码 2），绝不静默忽略。
 */

export interface ParsedArgs {
  /** 子命令与位置参数，如 ['import', 'figma'] */
  positionals: string[];
  /** 单值或布尔；重复出现时取最后一次（数组请用 list） */
  flags: Map<string, string | true>;
  /** 所有出现过的值，按出现顺序 */
  lists: Map<string, string[]>;
  /** 解析过程中发现的问题，交由调用方以退出码 2 报告 */
  errors: string[];
}

const VALUE_FLAGS = new Set([
  'ir',
  'out',
  'format',
  'target',
  'canvas',
  'seed',
  'count',
  'port',
  'fail-on',
  'from',
  'file',
  'node',
  'rows',
  'scale',
  'theme',
  'config',
  'name',
  'decisions',
  'width',
  'height',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const errors: string[] = [];

  const push = (key: string, value: string): void => {
    flags.set(key, value);
    const arr = lists.get(key) ?? [];
    // 逗号分隔与重复传参等价：agent 更喜欢 `--target vue,nestjs`
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0) arr.push(trimmed);
    }
    lists.set(key, arr);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        push(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        push(body, next);
        i++;
      } else {
        flags.set(body, true);
        lists.set(body, [...(lists.get(body) ?? []), 'true']);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // 只支持 -h / -v 这类单字母开关，不做组合短选项（组合语义容易被误用）
      const key = arg.slice(1);
      if (key === 'h') flags.set('help', true);
      else if (key === 'v') flags.set('version', true);
      else errors.push(`未知短选项：${arg}`);
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags, lists, errors };
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, key: string): boolean {
  return args.flags.get(key) === true || args.flags.get(key) === 'true';
}

export function flagList(args: ParsedArgs, key: string): string[] {
  return args.lists.get(key) ?? [];
}

/**
 * 校验参数白名单。
 *
 * 必须做的事：拼错的参数（`--ou` 而不是 `--out`）会让命令跑成默认行为，
 * 而用户以为「导出到了别处」。宁可拒绝执行也不能猜。
 */
export function rejectUnknown(args: ParsedArgs, allowed: string[]): string[] {
  const allow = new Set([...allowed, 'help', 'version']);
  const unknown: string[] = [...args.errors];
  for (const key of args.flags.keys()) {
    if (!allow.has(key)) unknown.push(`未知参数：--${key}（本命令支持：${allowed.map((a) => `--${a}`).join(' ')}）`);
  }
  return unknown;
}
