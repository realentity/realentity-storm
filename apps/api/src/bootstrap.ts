import { type INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";

/** HTTP setup shared by main.ts and the integration tests, so tests run the same pipeline as production. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("api");
  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();
}
