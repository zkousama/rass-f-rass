// Load environment variables from .env file
import dotenv from "dotenv";
dotenv.config();

// Import dependencies
import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyIO from "fastify-socket.io";
import Redis from "ioredis";
import closeWithGrace from "close-with-grace";
import { Socket } from "socket.io";

// Set default values for environment variables
const { PORT = "3001", HOST = "0.0.0.0", CORS_ORIGIN = "http://localhost:3000", UPSTASH_REDIS_REST_URL } = process.env;

// Check if UPSTASH_REDIS_REST_URL is present
if (!UPSTASH_REDIS_REST_URL) {
  throw new Error("Missing UPSTASH_REDIS_REST_URL");
}

// Create Redis instances
const publisher = new Redis(UPSTASH_REDIS_REST_URL, {
  tls: {
    rejectUnauthorized: false,
  },
});

const subscriber = new Redis(UPSTASH_REDIS_REST_URL, {
  tls: {
    rejectUnauthorized: false,
  },
});

// Create Fastify instance
const app = fastify();

// Set up connection counter
let connectedClients = 0;

// Function to build server
async function buildServer() {
  // Register CORS and socket.io plugins
  await app.register(fastifyCors, { origin: CORS_ORIGIN });
  await app.register(fastifyIO);

  // Set initial connection count
  await publisher.set("chat:connection-count", 0);

  // Event handler for new connections
  (app as any).io.on("connection", async (io: Socket) => {
    console.log("Client connected");

    // Increment connection count
    const incResult = await publisher.incr("chat:connection-count");
    connectedClients++;

    // Publish updated connection count
    await publisher.publish("chat:connection-count-updated", incResult.toString());

    // Event handler for disconnections
    io.on("disconnect", async () => {
      console.log("Client disconnected");

      // Decrement connection count
      const decResult = await publisher.decr("chat:connection-count");
      connectedClients--;

      // Publish updated connection count
      await publisher.publish("chat:connection-count-updated", decResult.toString());
    });
  });

  // Return Fastify instance
  return app;
}

// Main function
async function main() {
  // Build server
  const app = await buildServer();

  try {
    // Start server
    await app.listen({ port: parseInt(PORT, 10), host: HOST });
    console.log(`Server started at http://${HOST}:${PORT}`);

    // Function to close server gracefully
    closeWithGrace({ delay: 2000 }, async ({ signal, err }) => {
      console.log("Shutting down...");
      console.log(err, signal);

      // Remove disconnected clients from connection count
      if (connectedClients > 0) {
        console.log(`Removing ${connectedClients} clients from the count.`);

        const currentCount = parseInt((await publisher.get("chat:connection-count")) || "0", 10);
        const newCount = Math.max(currentCount - connectedClients, 0);

        await publisher.set("chat:connection-count", newCount);
      }

      // Close server and Redis connections
      await Promise.all([app.close(), subscriber.quit()]);
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

// Start server
main();

