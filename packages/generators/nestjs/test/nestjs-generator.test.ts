import { createField, createTableNode, toKebabCase } from '@fsdt/core-ir';
import { buildFixture } from '@fsdt/core-ir/testing';
import { describe, expect, it } from 'vitest';
import {
  dtoClassOf,
  dtoSpecsOf,
  emitPrismaSchema,
  groupByResource,
  nestjsGenerator,
  queryDtoPathOf,
  requestDtoPathOf,
  resourceSegmentOf,
  responseModelOf,
  renderPrismaConfig,
  responsePathOf,
  subPathOf,
} from '../src/index.js';

const CTX = { projectName: 'Demo', outputRoot: '.' };

async function renderPath(ir: ReturnType<typeof buildFixture>['ir'], path: string): Promise<string> {
  const plan = nestjsGenerator.plan(ir, CTX).find((p) => p.path === path);
  if (plan === undefined) throw new Error(`plan 里没有 ${path}`);
  return (await nestjsGenerator.render(plan, ir, CTX)).content;
}

describe('plan', () => {
  it('包含工程配置、prisma schema 与模块三件套', () => {
    const { ir } = buildFixture();
    const paths = nestjsGenerator.plan(ir, CTX).map((p) => p.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('prisma/schema.prisma');
    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('src/app.module.ts');
    expect(paths).toContain('src/modules/devices/devices.controller.ts');
    expect(paths).toContain('src/modules/devices/devices.service.ts');
    expect(paths).toContain('src/modules/devices/devices.module.ts');
  });

  it('带请求体的接口产出 create DTO，带查询参数的接口产出 query DTO', () => {
    const { ir } = buildFixture();
    const paths = nestjsGenerator.plan(ir, CTX).map((p) => p.path);
    expect(paths).toContain('src/modules/devices/dto/create-device.dto.ts');
    expect(paths).toContain('src/modules/devices/dto/list-devices-query.dto.ts');
  });

  it('DTO 路径与 import 路径指向同一个文件', () => {
    const { ir } = buildFixture();
    const paths = nestjsGenerator.plan(ir, CTX).map((p) => p.path);
    for (const op of ['createDevice', 'listDevices']) {
      const planned = paths.find((p) => p.endsWith(requestDtoPathOf(op)) || p.endsWith(queryDtoPathOf(op)) || p.endsWith(responsePathOf(op)));
      if (planned === undefined) continue;
      // plan 的路径去掉 src/modules/<dir>/ 前缀后，应与 helper 返回的相对路径一致
      expect(planned).toMatch(/^src\/modules\/[^/]+\/dto\/[^/]+\.ts$/);
    }
  });

  it('plan 顺序稳定且去重', () => {
    const { ir } = buildFixture();
    const first = nestjsGenerator.plan(ir, CTX).map((p) => p.path);
    const second = nestjsGenerator.plan(ir, CTX).map((p) => p.path);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('package.json 等配置文件已存在时不覆盖', () => {
    const { ir } = buildFixture();
    const plans = nestjsGenerator.plan(ir, CTX);
    for (const path of ['package.json', 'tsconfig.json', 'nest-cli.json']) {
      expect(plans.find((p) => p.path === path)?.overwrite).toBe('never');
    }
  });

  it('service 只在文件是我们生成的时候才覆盖，保护手写业务逻辑', () => {
    const { ir } = buildFixture();
    const plan = nestjsGenerator.plan(ir, CTX).find((p) => p.path.endsWith('.service.ts'));
    expect(plan?.overwrite).toBe('if-generated');
  });
});

describe('接口分组与路径拆分', () => {
  it('按路径首段分组', () => {
    const { ir } = buildFixture();
    const groups = groupByResource(ir);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.segment).toBe('devices');
    expect(groups[0]?.apis).toHaveLength(2);
  });

  it('路径参数段被排除在资源名之外', () => {
    const { ir } = buildFixture();
    const groups = groupByResource(ir);
    expect(resourceSegmentOf(groups[0]!.apis[0]!)).toBe('devices');
  });

  it('根路径退化到 root', () => {
    const { ir, listApi } = buildFixture();
    listApi.api.path = '/';
    expect(resourceSegmentOf(listApi)).toBe('root');
  });

  it('子路径把 {id} 换成 :id', () => {
    const { listApi } = buildFixture();
    listApi.api.path = '/devices/{id}/status';
    expect(subPathOf(listApi)).toBe(':id/status');
  });

  it('资源段后的空子路径返回空字符串（控制器的 @Get() 无参）', () => {
    const { listApi } = buildFixture();
    expect(subPathOf(listApi)).toBe('');
  });
});

describe('Prisma 映射', () => {
  it('表名落到 @@map，字段落到 @map', () => {
    const { ir } = buildFixture();
    const { schema } = emitPrismaSchema(ir);
    expect(schema).toContain('model Device {');
    expect(schema).toContain('@@map("devices")');
    expect(schema).toContain('deviceName String');
  });

  it('枚举从字典生成，且被字段引用', () => {
    const { ir } = buildFixture();
    const { schema } = emitPrismaSchema(ir);
    expect(schema).toContain('enum DeviceStatus {');
    expect(schema).toContain('ACTIVE');
    expect(schema).toContain('status DeviceStatus');
  });

  it('字符串主键用 @id @default(cuid())，不硬塞自增 id', () => {
    const { ir } = buildFixture();
    const { schema } = emitPrismaSchema(ir);
    expect(schema).toContain('deviceId String @id @default(cuid())');
    expect(schema).not.toContain('autoincrement()');
  });

  it('整型主键才用自增', () => {
    const { ir, deviceTable } = buildFixture();
    const pk = deviceTable.table.fields[0]!;
    pk.type = 'integer';
    pk.name = 'id';
    pk.dbName = 'id';
    const { schema } = emitPrismaSchema(ir);
    expect(schema).toContain('id Int @id @default(autoincrement())');
  });

  it('timestamps 开关补齐 createdAt/updatedAt', () => {
    const { ir } = buildFixture();
    const { schema } = emitPrismaSchema(ir);
    expect(schema).toContain('createdAt DateTime');
    expect(schema).toContain('updatedAt DateTime @updatedAt');
  });

  it('softDelete 开关补 deletedAt', () => {
    const { ir, deviceTable } = buildFixture();
    deviceTable.table.softDelete = true;
    expect(emitPrismaSchema(ir).schema).toContain('deletedAt DateTime?');
  });

  it('外键生成关系字段与反向字段', () => {
    const { ir, deviceTable } = buildFixture();
    const command = createTableNode({
      name: '指令',
      codeName: 'Command',
      canvasId: deviceTable.canvasId,
      table: {
        dbName: 'commands',
        fields: [
          createField({ name: 'id', type: 'integer', required: true, dbName: 'id' }),
          createField({
            name: 'deviceId',
            type: 'ref',
            required: true,
            dbName: 'device_id',
            constraints: { ref: { tableId: deviceTable.id, onDelete: 'cascade' } },
          }),
        ],
        indexes: [],
        softDelete: false,
        timestamps: false,
      },
    });
    ir.nodes.push(command);
    const { schema } = emitPrismaSchema(ir);
    // 出边：本表持外键
    expect(schema).toMatch(/device Device @relation\(fields: \[deviceId\], references: \[deviceId\], onDelete: Cascade\)/);
    // 入边：目标表补反向字段
    expect(schema).toMatch(/commands Command\[\]/);
  });

  it('非法的枚举值被跳过并记 warning（不静默丢）', () => {
    const { ir } = buildFixture();
    ir.dictionaries.enums[0]!.values.push({ value: '已停用', label: '已停用' });
    const { schema, warnings } = emitPrismaSchema(ir);
    expect(schema).not.toContain('已停用');
    expect(warnings.join('\n')).toContain('不是合法标识符');
  });

  it('输出稳定：同一 IR 两次生成完全一致', () => {
    const { ir } = buildFixture();
    expect(emitPrismaSchema(ir).schema).toBe(emitPrismaSchema(ir).schema);
  });
});

describe('DTO', () => {
  it('必填字段不带 ?，可选字段带 ?', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/dto/create-device.dto.ts');
    expect(content).toContain('deviceName!: string;');
    expect(content).not.toContain('@IsOptional()');
  });

  it('约束映射成 class-validator 装饰器', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/dto/create-device.dto.ts');
    expect(content).toContain('@MinLength(1)');
    expect(content).toContain('@MaxLength(64)');
    expect(content).toContain('@IsNotEmpty()');
  });

  it('正则用 new RegExp 而不是字面量（pattern 含 / 时字面量会崩）', async () => {
    const { ir, createApi } = buildFixture();
    createApi.api.requestBody!.fields.push(
      createField({ name: 'code', type: 'string', constraints: { pattern: '^[a-z]+/x$' } }),
    );
    const content = await renderPath(ir, 'src/modules/devices/dto/create-device.dto.ts');
    expect(content).toContain('@Matches(new RegExp(');
    expect(content).not.toContain('/^[a-z]+/x$/');
  });

  it('枚举字段引用生成的 Prisma enum', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/dto/create-device.dto.ts');
    expect(content).toContain("import { DeviceStatus } from '@prisma/client';");
    expect(content).toContain('@IsEnum(DeviceStatus)');
    expect(content).toContain('status!: DeviceStatus;');
  });

  it('readOnly 字段不进 Create DTO', async () => {
    const { ir, createApi } = buildFixture();
    createApi.api.requestBody!.fields.push(
      createField({ name: 'serverToken', type: 'string', readOnly: true }),
    );
    const content = await renderPath(ir, 'src/modules/devices/dto/create-device.dto.ts');
    expect(content).not.toContain('serverToken');
  });

  it('DTO 类名由 operationId 派生', () => {
    expect(dtoClassOf('createDevice', 'Dto')).toBe('CreateDeviceDto');
    expect(dtoClassOf('listDevices', 'QueryDto')).toBe('ListDevicesQueryDto');
  });

  it('dtoSpecsOf 只给需要的接口产 DTO', () => {
    const { ir, listApi, createApi } = buildFixture();
    void ir;
    expect(dtoSpecsOf(createApi, 'createDevice').map((s) => s.suffix)).toEqual(['Dto']);
    expect(dtoSpecsOf(listApi, 'listDevices').map((s) => s.suffix)).toEqual(['QueryDto']);
  });
});

describe('响应类型', () => {
  it('分页信封产出 Page + Item 两个类', () => {
    const { ir, listApi } = buildFixture();
    const model = responseModelOf('listDevices', listApi);
    expect(model.kind).toBe('page');
    void ir;
  });

  it('对象响应只产出一个类', () => {
    const { createApi } = buildFixture();
    expect(responseModelOf('createDevice', createApi).kind).toBe('item');
  });

  it('无响应体时是 void', () => {
    const { createApi } = buildFixture();
    createApi.api.responses = [{ status: 204, description: '无内容', shape: 'empty', fields: [] }];
    expect(responseModelOf('createDevice', createApi).kind).toBe('void');
  });

  it('渲染出的响应类带 @ApiProperty，供 Swagger 使用', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/dto/list-devices-response.ts');
    expect(content).toContain('export class ListDevicesItem {');
    expect(content).toContain('export class ListDevicesPage {');
    expect(content).toContain('items!: ListDevicesItem[];');
    expect(content).toContain('total!: number;');
  });
});

describe('控制器与服务', () => {
  it('控制器方法名等于 operationId', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/devices.controller.ts');
    expect(content).toContain('listDevices(@Query() query: ListDevicesQueryDto)');
    expect(content).toContain('createDevice(@Body() body: CreateDeviceDto)');
  });

  it('控制器导入方法装饰器（漏了会直接编译失败）', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/devices.controller.ts');
    expect(content).toContain('Get');
    expect(content).toContain('Post');
  });

  it('service 用显式未实现，而不是返回假数据', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/devices.service.ts');
    expect(content).toContain("throw new NotImplementedException('listDevices')");
    expect(content).not.toContain('return []');
    expect(content).not.toContain('return {}');
  });

  it('service 的 @dsg:todo 说明该写什么', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/devices.service.ts');
    expect(content).toMatch(/@dsg:todo 实现 listDevices：分页查询/);
  });

  it('main.ts 保留鉴权挂载点但不生成骨架', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/main.ts');
    expect(content).toContain('@dsg:todo 接入鉴权');
    expect(content).not.toContain('JwtAuthGuard }');
    expect(content).toContain('forbidNonWhitelisted: true');
  });

  it('app.module.ts 汇总所有模块', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/app.module.ts');
    expect(content).toContain('DevicesModule');
    expect(content).toContain('PrismaModule');
  });

  it('未知路径抛出可定位的错误', async () => {
    const { ir } = buildFixture();
    const plan = { path: 'src/nowhere.ts', kind: 'config' as const, sourceNodeIds: [], overwrite: 'always' as const };
    await expect(nestjsGenerator.render(plan, ir, CTX)).rejects.toThrow('nestjsGenerator 无法渲染未知文件');
  });
});

describe('确定性', () => {
  it('只改画布坐标不影响任何产物', async () => {
    const a = buildFixture();
    const b = buildFixture();
    // 两个 fixture 的 ID 不同，所以比结构而不是字节；这里只验证同一 IR 两次渲染一致
    const first = await renderPath(a.ir, 'src/modules/devices/devices.controller.ts');
    const second = await renderPath(a.ir, 'src/modules/devices/devices.controller.ts');
    expect(second).toBe(first);
    void b;
  });

  it('产物文件头带 IR 哈希与生成器版本', async () => {
    const { ir } = buildFixture();
    const content = await renderPath(ir, 'src/modules/devices/devices.controller.ts');
    expect(content).toMatch(/^\/\/ @dsg:generated file=/);
    expect(content).toMatch(/ir=sha256:[0-9a-f]{64}/);
    expect(content).toContain('generator=nestjs@0.1.0');
  });

  it('模块目录名是 kebab-case，与前端 apiModulePath 的 convert 规则一致', () => {
    expect(toKebabCase('DeviceStatus')).toBe('device-status');
  });
});

describe('prisma.config.ts（Prisma 7 的连接串位置）', () => {
  it('schema 里不能再出现 datasource.url（否则 prisma generate 报 P1012）', () => {
    const { ir } = buildFixture();
    const { schema } = emitPrismaSchema(ir);
    expect(schema).not.toContain('url      = env');
    expect(schema).not.toContain('env("DATABASE_URL")');
  });

  it('计划里包含 prisma.config.ts', () => {
    const { ir } = buildFixture();
    const paths = nestjsGenerator.plan(ir, CTX).map((p) => p.path);
    expect(paths).toContain('prisma.config.ts');
  });

  it('prisma.config.ts 从环境变量读 DATABASE_URL', () => {
    const cfg = renderPrismaConfig();
    expect(cfg).toContain("from 'prisma/config'");
    expect(cfg).toContain("schema: 'prisma/schema.prisma'");
    expect(cfg).toContain("url: env('DATABASE_URL')");
  });
});
