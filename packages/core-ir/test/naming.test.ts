import { describe, expect, it } from 'vitest';

import {
  fieldToApiName,
  fieldToDbName,
  isIdentifier,
  pathToOperationId,
  pluralize,
  RESERVED_WORDS,
  safeIdentifier,
  singularize,
  splitWords,
  tableToModelName,
  tableToPathSegment,
  toCamelCase,
  toConstantCase,
  toFileName,
  toKebabCase,
  toPackageName,
  toPascalCase,
  toSnakeCase,
} from '../src/index.js';

describe('splitWords', () => {
  it('按分隔符切分', () => {
    expect(splitWords('device_log')).toEqual(['device', 'log']);
    expect(splitWords('device-log')).toEqual(['device', 'log']);
    expect(splitWords('device log')).toEqual(['device', 'log']);
    expect(splitWords('device.log')).toEqual(['device', 'log']);
  });

  it('按大小写边界切分', () => {
    expect(splitWords('deviceLog')).toEqual(['device', 'Log']);
    expect(splitWords('DeviceLog')).toEqual(['Device', 'Log']);
    expect(splitWords('deviceID')).toEqual(['device', 'ID']);
  });

  it('连续大写只在末尾小写前切分（HTTPServer → HTTP + Server）', () => {
    expect(splitWords('HTTPServer')).toEqual(['HTTP', 'Server']);
    expect(splitWords('parseJSONFile')).toEqual(['parse', 'JSON', 'File']);
  });

  it('空串与纯分隔符', () => {
    expect(splitWords('')).toEqual([]);
    expect(splitWords('___')).toEqual([]);
  });
});

describe('大小写转换', () => {
  it('camelCase', () => {
    expect(toCamelCase('device_log')).toBe('deviceLog');
    expect(toCamelCase('DeviceLog')).toBe('deviceLog');
    expect(toCamelCase('device-log')).toBe('deviceLog');
  });

  it('PascalCase', () => {
    expect(toPascalCase('device_log')).toBe('DeviceLog');
    expect(toPascalCase('deviceLog')).toBe('DeviceLog');
  });

  it('snake_case', () => {
    expect(toSnakeCase('deviceLog')).toBe('device_log');
    expect(toSnakeCase('DeviceLog')).toBe('device_log');
  });

  it('kebab-case', () => {
    expect(toKebabCase('deviceLog')).toBe('device-log');
    expect(toKebabCase('DeviceLog')).toBe('device-log');
  });

  it('CONSTANT_CASE', () => {
    expect(toConstantCase('deviceStatus')).toBe('DEVICE_STATUS');
    expect(toConstantCase('device-status')).toBe('DEVICE_STATUS');
  });

  it('往返转换稳定（幂等性）', () => {
    const samples = ['device_log', 'deviceLog', 'DeviceLog', 'device-log', 'DEVICE_STATUS'];
    for (const s of samples) {
      const once = toPascalCase(s);
      expect(toPascalCase(once)).toBe(once);
      const snake = toSnakeCase(s);
      expect(toSnakeCase(snake)).toBe(snake);
    }
  });
});

describe('pluralize', () => {
  it('常规加 s', () => {
    expect(pluralize('device')).toBe('devices');
    expect(pluralize('user')).toBe('users');
  });

  it('s/x/z/ch/sh 结尾加 es', () => {
    expect(pluralize('box')).toBe('boxes');
    expect(pluralize('class')).toBe('classes');
    expect(pluralize('watch')).toBe('watches');
    expect(pluralize('dish')).toBe('dishes');
  });

  it('辅音 + y 变 ies', () => {
    expect(pluralize('category')).toBe('categories');
    expect(pluralize('city')).toBe('cities');
  });

  it('元音 + y 直接加 s', () => {
    expect(pluralize('key')).toBe('keys');
    expect(pluralize('day')).toBe('days');
  });

  it('不规则复数', () => {
    expect(pluralize('person')).toBe('people');
    expect(pluralize('child')).toBe('children');
  });

  it('已经是复数时不重复复化（status → statuses 而非 statuseses）', () => {
    expect(pluralize('status')).toBe('statuses');
    expect(pluralize('statuses')).toBe('statuseses');
  });
});

describe('singularize', () => {
  it('常规去 s', () => {
    expect(singularize('devices')).toBe('device');
    expect(singularize('users')).toBe('user');
  });

  it('ies → y', () => {
    expect(singularize('categories')).toBe('category');
  });

  it('es 结尾', () => {
    expect(singularize('boxes')).toBe('box');
    expect(singularize('watches')).toBe('watch');
  });

  it('不规则', () => {
    expect(singularize('people')).toBe('person');
    expect(singularize('children')).toBe('child');
  });

  it('ss 结尾不当成复数', () => {
    expect(singularize('class')).toBe('class');
  });
});

describe('表名 → 各目标命名', () => {
  it('路径段用 kebab 复数', () => {
    expect(tableToPathSegment('DeviceLog', { tableCase: 'snake', fieldCase: 'camel', pathCase: 'kebab', fileCase: 'kebab' })).toBe(
      'device-logs',
    );
  });

  it('pathCase=snake 时用 snake 复数', () => {
    expect(tableToPathSegment('DeviceLog', { tableCase: 'snake', fieldCase: 'camel', pathCase: 'snake', fileCase: 'kebab' })).toBe(
      'device_logs',
    );
  });

  it('Prisma 模型名 Pascal 单数', () => {
    expect(tableToModelName('devices')).toBe('Device');
    expect(tableToModelName('device_logs')).toBe('DeviceLog');
  });

  it('字段名按 fieldCase 输出列名 / API 名', () => {
    const settings = { tableCase: 'snake' as const, fieldCase: 'snake' as const, pathCase: 'kebab' as const, fileCase: 'kebab' as const };
    expect(fieldToDbName('deviceId', settings)).toBe('device_id');
    expect(fieldToApiName('deviceId', settings)).toBe('device_id');

    const camel = { ...settings, fieldCase: 'camel' as const };
    expect(fieldToDbName('device_id', camel)).toBe('deviceId');
    expect(fieldToApiName('device_id', camel)).toBe('deviceId');
  });

  it('文件名按 fileCase', () => {
    const kebab = { tableCase: 'snake' as const, fieldCase: 'camel' as const, pathCase: 'kebab' as const, fileCase: 'kebab' as const };
    expect(toFileName('DeviceList', kebab, 'vue')).toBe('device-list.vue');
    const pascal = { ...kebab, fileCase: 'pascal' as const };
    expect(toFileName('device-list', pascal, 'vue')).toBe('DeviceList.vue');
  });
});

describe('pathToOperationId', () => {
  it('GET /devices → getDevices', () => {
    expect(pathToOperationId('GET', '/devices')).toBe('getDevices');
  });

  it('GET /devices/{id} → getDevicesById', () => {
    expect(pathToOperationId('GET', '/devices/{id}')).toBe('getDevicesById');
  });

  it('POST /device-logs → postDeviceLogs', () => {
    expect(pathToOperationId('POST', '/device-logs')).toBe('postDeviceLogs');
  });

  it('嵌套路径', () => {
    expect(pathToOperationId('DELETE', '/devices/{deviceId}/logs/{logId}')).toBe(
      'deleteDevicesByDeviceIdLogsByLogId',
    );
  });
});

describe('标识符安全', () => {
  it('isIdentifier 判断合法 JS 标识符', () => {
    expect(isIdentifier('deviceId')).toBe(true);
    expect(isIdentifier('_private')).toBe(true);
    expect(isIdentifier('$dollar')).toBe(true);
    expect(isIdentifier('123abc')).toBe(false);
    expect(isIdentifier('device-id')).toBe(false);
    expect(isIdentifier('')).toBe(false);
  });

  it('保留字被 safeIdentifier 改写', () => {
    expect(RESERVED_WORDS.has('class')).toBe(true);
    expect(safeIdentifier('class')).toBe('class_');
    expect(safeIdentifier('default')).toBe('default_');
    expect(safeIdentifier('deviceId')).toBe('deviceId');
  });
});

describe('toPackageName', () => {
  it('中文项目名剥不出 ASCII 时用 fallback（否则 npm install 会失败）', () => {
    expect(toPackageName('设备管理', 'fsdt-frontend')).toBe('fsdt-frontend');
  });

  it('中英混合时保留英文部分', () => {
    expect(toPackageName('设备 Device Manager')).toBe('device-manager');
  });

  it('大写、空格、下划线统一为小写连字符', () => {
    expect(toPackageName('My_Awesome  Tool')).toBe('my-awesome-tool');
  });

  it('去掉首尾与重复的分隔符', () => {
    expect(toPackageName('__my--tool__')).toBe('my-tool');
  });

  it('超长名截断到 60 字符以内且不以分隔符结尾', () => {
    const long = toPackageName(`${'a'.repeat(80)}-tail`);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
  });

  it('纯符号同样回落到 fallback', () => {
    expect(toPackageName('///')).toBe('fsdt-app');
  });
});
