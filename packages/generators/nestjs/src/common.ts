/**
 * `src/common/` 下的三个公共件。
 *
 * 为什么生成它们：每个 NestJS 项目都会手写这三样，而手写的版本往往三处不一致
 * （分页参数校验收紧、异常格式各家不同、响应包装有时外面包一层有时不包）。
 * 生成一份统一的，至少让「同一工具产出的服务」长得一样。
 *
 * 响应包装默认**不注册**（见 renderMainTs 的注释）：包一层之后响应体就不再是
 * OpenAPI 里写的那个 schema，前端按契约写的类型会全部对不上。要用得自己决定。
 */
import { Writer } from '@fsdt/generators-runtime';

const HEADER = (file: string, irHash: string): string =>
  `// @dsg:generated file=${file} ir=${irHash} generator=nestjs@0.1.0`;

/** 列表接口的通用分页参数，供 DTO 继承 */
export function renderPaginationDto(irHash: string): string {
  const w = new Writer();
  w.line(HEADER('src/common/pagination.dto.ts', irHash));
  w.line("import { Type } from 'class-transformer';");
  w.line("import { IsInt, IsOptional, Max, Min } from 'class-validator';");
  w.blank();
  w.line('/**');
  w.line(' * 分页查询参数。');
  w.line(' *');
  w.line(' * `@Type(() => Number)` 不能省：查询串里的值都是字符串，');
  w.line(' * 没有它 `@IsInt()` 会把 "1" 判成不合法。');
  w.line(' */');
  w.line('export class PaginationQueryDto {');
  w.line('  @IsOptional()');
  w.line('  @Type(() => Number)');
  w.line('  @IsInt()');
  w.line('  @Min(1)');
  w.line('  page: number = 1;');
  w.blank();
  w.line('  @IsOptional()');
  w.line('  @Type(() => Number)');
  w.line('  @IsInt()');
  w.line('  @Min(1)');
  w.line('  @Max(200)');
  w.line('  pageSize: number = 20;');
  w.line('}');
  return w.toString();
}

/** 统一异常格式：把 HttpException 与未捕获异常收敛成同一个 JSON 形状 */
export function renderExceptionFilter(irHash: string): string {
  const w = new Writer();
  w.line(HEADER('src/common/http-exception.filter.ts', irHash));
  w.line(
    "import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';",
  );
  w.blank();
  w.line('/** 只声明用到的成员：避免为了两个方法去依赖 @types/express */');
  w.line('interface RequestLike {');
  w.line('  url: string;');
  w.line('  method: string;');
  w.line('}');
  w.blank();
  w.line('interface ResponseLike {');
  w.line('  status(code: number): { json(body: unknown): void };');
  w.line('}');
  w.blank();
  w.line('export interface ErrorBody {');
  w.line('  statusCode: number;');
  w.line('  message: string | string[];');
  w.line('  method: string;');
  w.line('  path: string;');
  w.line('  timestamp: string;');
  w.line('}');
  w.blank();
  w.line('@Catch()');
  w.line('export class AllExceptionsFilter implements ExceptionFilter {');
  w.line('  private readonly logger = new Logger(AllExceptionsFilter.name);');
  w.blank();
  w.line('  catch(exception: unknown, host: ArgumentsHost): void {');
  w.line('    const ctx = host.switchToHttp();');
  w.line('    const response = ctx.getResponse<ResponseLike>();');
  w.line('    const request = ctx.getRequest<RequestLike>();');
  w.blank();
  w.line(
    '    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;',
  );
  w.line('    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;');
  w.line('    const message =');
  w.line("      typeof payload === 'string'");
  w.line('        ? payload');
  w.line("        : payload !== null && typeof payload === 'object' && 'message' in payload");
  w.line('          ? (payload as { message: string | string[] }).message');
  w.line("          : exception instanceof Error");
  w.line('            ? exception.message');
  w.line("            : '服务器内部错误';");
  w.blank();
  w.line('    // 5xx 才打堆栈：4xx 是用户输入问题，逐条打日志只会淹没真正的故障');
  w.line('    if (status >= 500) {');
  w.line('      this.logger.error(');
  w.line('        `${request.method} ${request.url} → ${String(status)}`,');  
  w.line('        exception instanceof Error ? exception.stack : undefined,');
  w.line('      );');
  w.line('    }');
  w.blank();
  w.line('    const body: ErrorBody = {');
  w.line('      statusCode: status,');
  w.line('      message,');
  w.line('      method: request.method,');
  w.line('      path: request.url,');
  w.line('      timestamp: new Date().toISOString(),');
  w.line('    };');
  w.line('    response.status(status).json(body);');
  w.line('  }');
  w.line('}');
  return w.toString();
}

/** 统一响应包装（默认不注册，见文件头注释） */
export function renderResponseInterceptor(irHash: string): string {
  const w = new Writer();
  w.line(HEADER('src/common/response.interceptor.ts', irHash));
  w.line("import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';");
  w.line("import type { Observable } from 'rxjs';");
  w.line("import { map } from 'rxjs/operators';");
  w.blank();
  w.line('export interface ApiResponse<T> {');
  w.line('  code: number;');
  w.line('  message: string;');
  w.line('  data: T;');
  w.line('}');
  w.blank();
  w.line('/**');
  w.line(' * 把每个成功响应包成 `{ code, message, data }`。');
  w.line(' *');
  w.line(' * 注意：启用后响应体不再等于 OpenAPI 里声明的 schema，前端按契约生成的类型会对不上，');
  w.line(' * 需要两边一起改。所以这里只生成文件，不替你注册。');
  w.line(' * 用法：在 main.ts 里 `app.useGlobalInterceptors(new ResponseInterceptor())`。');
  w.line(' */');
  w.line('@Injectable()');
  w.line('export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {');
  w.line('  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {');
  w.line("    return next.handle().pipe(map((data) => ({ code: 0, message: 'ok', data })));");
  w.line('  }');
  w.line('}');
  return w.toString();
}
