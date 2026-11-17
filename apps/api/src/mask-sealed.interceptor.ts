import { maskSealed } from "@realentity/storm-shared";
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { map, type Observable } from "rxjs";

/**
 * M52: every answer with each encrypted field's sealed value as `***`: an entity, a run's step input and output, a
 * trigger's data, a proposal's payload. The ciphertext is useless without the key, but it never leaves the api either:
 * a page needs only to know that a value is set.
 */
@Injectable()
export class MaskSealedInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // maskSealed goes into plain objects and arrays only: a file's StreamableFile or a Buffer passes as it is.
    return next.handle().pipe(map((body: unknown) => maskSealed(body)));
  }
}
