import mongoose from "mongoose";
import { logger } from "../utils/logger";

mongoose.set("strictQuery", true);

mongoose.connection.on("error", (err) => {
  logger.error("mongodb connection error", { message: String(err) });
});

mongoose.connection.on("disconnected", () => {
  logger.warn("mongodb disconnected");
});

export async function connectDatabase(uri: string): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  logger.info("mongodb connected");
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info("mongodb disconnected cleanly");
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}
