import { createServer } from 'node:http';

const STATUSES = ['ACTIVE', 'OFFLINE', 'MAINTENANCE'];
const OWNERS = ['张伟', '李娜', '王强', '刘洋', '陈静'];
const NAMES = ['边缘网关', '采集器', '温湿度传感器', '工业相机', 'PLC 控制器', '路由器'];

function seeded(i) {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

const ALL = Array.from({ length: 57 }, (_, i) => {
  const r = seeded(i + 1);
  return {
    id: i + 1,
    name: `${NAMES[i % NAMES.length]}-${String(i + 1).padStart(3, '0')}`,
    serialNumber: `SN${String(20260000 + i * 37).slice(0, 8)}`,
    status: STATUSES[Math.floor(r * 3)],
    ipAddress: `10.20.${(i % 6) + 1}.${(i * 7) % 250 + 2}`,
    owner: OWNERS[i % OWNERS.length],
    enabled: r > 0.25,
    purchasedAt: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
  };
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api/, '');

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && path === '/devices') {
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    const keyword = (url.searchParams.get('keyword') ?? '').trim();
    const status = url.searchParams.get('status') ?? '';

    let list = ALL;
    if (keyword) list = list.filter((d) => d.name.includes(keyword) || d.serialNumber.includes(keyword));
    if (status) list = list.filter((d) => d.status === status);

    const start = (page - 1) * pageSize;
    return json(res, 200, { items: list.slice(start, start + pageSize), total: list.length });
  }

  if (req.method === 'POST' && path === '/devices') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { message: '请求体不是合法 JSON' });
      }
      const id = ALL.length + 1;
      ALL.unshift({
        id,
        name: body.name ?? '(未命名)',
        serialNumber: body.serialNumber ?? '-',
        status: body.status ?? 'OFFLINE',
        ipAddress: body.ipAddress ?? '-',
        owner: body.owner ?? '-',
        enabled: body.enabled ?? true,
        purchasedAt: body.purchasedAt ?? '-',
      });
      console.log(`[mock] 新建设备 #${id} ${body.name ?? ''}`);
      return json(res, 201, { id });
    });
    return;
  }

  json(res, 404, { message: `mock 未实现 ${req.method} ${path}` });
});

server.listen(3000, () => {
  console.log('[mock] 已启动 http://localhost:3000  （共 %d 条设备）', ALL.length);
});
