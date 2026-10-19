/**
 * 导出主题。
 *
 * 单独一层的理由：SVG / drawio / png 三个格式必须共用同一套颜色与字号，
 * 否则同一个画布导出成三种格式看起来是三个产品，用户会以为是 bug。
 * 而且颜色写死在各渲染器里时，加「深色模式」要改三处。
 */

export interface ExportTheme {
  id: 'light' | 'dark';
  background: string;
  grid: string;
  nodeFill: Record<string, string>;
  nodeStroke: string;
  titleColor: string;
  bodyColor: string;
  mutedColor: string;
  edgeColor: Record<string, string>;
  fontFamily: string;
  titleSize: number;
  bodySize: number;
  /** 节点内一行的高度 */
  lineHeight: number;
  padding: number;
  radius: number;
}

/**
 * 字体栈。
 *
 * 这里**必须用单引号**包字体名：这个字符串会被直接插进 SVG 的
 * `font-family="..."` 属性里，双引号会提前关闭属性，产出的 SVG 是非法 XML
 * （resvg 报 `invalid attribute ... expected space not 'P'`，
 * 而浏览器可能仍然能渲染，于是问题只在 PNG 导出时暴露）。
 */
const CJK_FIRST =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif";

export const LIGHT_THEME: ExportTheme = {
  id: 'light',
  background: '#ffffff',
  grid: '#eef0f3',
  nodeFill: {
    table: '#f3f7ff',
    api: '#f2fbf5',
    page: '#fff8f0',
    note: '#fbf8e8',
  },
  nodeStroke: '#c9ced6',
  titleColor: '#1c2330',
  bodyColor: '#41505f',
  mutedColor: '#8a94a6',
  edgeColor: {
    call: '#2f6fd0',
    read: '#2f9e6b',
    write: '#c2410c',
    map: '#7c5cd6',
    navigate: '#b08a00',
  },
  fontFamily: CJK_FIRST,
  titleSize: 14,
  bodySize: 12,
  lineHeight: 18,
  padding: 10,
  radius: 6,
};

export const DARK_THEME: ExportTheme = {
  id: 'dark',
  background: '#15181d',
  grid: '#252a33',
  nodeFill: {
    table: '#1d2734',
    api: '#182b22',
    page: '#2b2318',
    note: '#2a2718',
  },
  nodeStroke: '#3a424f',
  titleColor: '#e8ecf2',
  bodyColor: '#b6c0cf',
  mutedColor: '#7d8899',
  edgeColor: {
    call: '#6ba4f5',
    read: '#5ecb95',
    write: '#f08a5d',
    navigate: '#e0c060',
    map: '#a98ff0',
  },
  fontFamily: CJK_FIRST,
  titleSize: 14,
  bodySize: 12,
  lineHeight: 18,
  padding: 10,
  radius: 6,
};

export function themeOf(id: 'light' | 'dark'): ExportTheme {
  return id === 'dark' ? DARK_THEME : LIGHT_THEME;
}

/** 节点类型的显示名，导出图里出现在标题右侧的灰色小字上 */
export const KIND_LABEL: Record<string, string> = {
  table: '数据表',
  api: '接口',
  page: '页面',
  note: '备注',
};
