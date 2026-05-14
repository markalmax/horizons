import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object' && 'message' in res) {
        const m = (res as { message: unknown }).message;
        if (typeof m === 'string' || Array.isArray(m)) {
          message = m as string | string[];
        } else {
          message = exception.message;
        }
      } else {
        message = exception.message;
      }
    }

    console.error('Exception caught:', exception);

    response.status(status).json({
      success: false,
      error: message,
    });
  }
}
