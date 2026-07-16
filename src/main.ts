import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApiApplication } from "./bootstrap.js";
import { validateApiConfig } from "./config/api-config.js";

const config = validateApiConfig(process.env);
const port = config.PORT;
const app = await NestFactory.create(AppModule);

configureApiApplication(app, config);

await app.listen(port, "0.0.0.0");
