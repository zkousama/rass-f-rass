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
import { randomUUID } from "crypto";

// Set default values for environment variables
const { PORT = "3001", HOST = "0.0.0.0", CORS_ORIGIN = "http://localhost:3000", UPSTASH_REDIS_REST_URL } = process.env;

// Set constants
const CONNECTION_COUNT_KEY = "chat:connection-count";
const CONNECTION_COUNT_UPDATED_CHANNEL = "chat:connection-count-updated";
const NEW_MESSAGE_CHANNEL = "chat:new-message";
const MESSAGES_KEY = "chat:messages";

/* const sendMessageToRoom = (room: string, messageContents: string) => {
  const channel = `chat:${room}:messages`;
} */

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
  await publisher.set(CONNECTION_COUNT_KEY, 0);

  // Event handler for new connections
  app.io.on("connection", async (io) => { // FIXME fix io type
    console.log("Client connected");

    // Increment connection count
    const incResult = await publisher.incr(CONNECTION_COUNT_KEY);
    connectedClients++;

    // Publish updated connection count
    await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, incResult.toString());

    // Event handler for new messages
    io.on(NEW_MESSAGE_CHANNEL, async (payload) => { // FIXME fix message type
      const message = payload?.message;
      if(!message) {
        return;
      }
      
      console.log("Received new message", message);
      await publisher.publish(NEW_MESSAGE_CHANNEL, message.toString());
    });

    // Event handler for disconnections
    io.on("disconnect", async () => {
      console.log("Client disconnected");

      // Decrement connection count
      const decResult = await publisher.decr(CONNECTION_COUNT_KEY);
      connectedClients--;

      // Publish updated connection count
      await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, decResult.toString());
    });
  });

  // Subscribe to connection count updates
  subscriber.subscribe(CONNECTION_COUNT_UPDATED_CHANNEL, (err, count) => {
    if (err) {
      console.error(`Error subscribing to ${CONNECTION_COUNT_UPDATED_CHANNEL}`, err);
      return;
    }
    console.log(`${count} Clients subscribed to ${CONNECTION_COUNT_UPDATED_CHANNEL} channel`);
  });

  // Subscribe to new messages
  subscriber.subscribe(NEW_MESSAGE_CHANNEL, (err, count) => {
    if (err) {
      console.error(`Error subscribing to ${NEW_MESSAGE_CHANNEL}`, err);
      return;
    }
    console.log(`${count} Clients connected to ${NEW_MESSAGE_CHANNEL} channel`);
    }
  );

  // Event handler for new messages
  subscriber.on("message", (channel, text) => {
    if (channel === CONNECTION_COUNT_UPDATED_CHANNEL) {
      app.io.emit(CONNECTION_COUNT_UPDATED_CHANNEL, { // FIXME fix io type
        count: text,
      });

      return;
    }

    if(channel === NEW_MESSAGE_CHANNEL) {
      app.io.emit(NEW_MESSAGE_CHANNEL, { // FIXME fix io type
        message: text,
        id: randomUUID(),
        createdAt: new Date(),
        port: PORT
      });
      return;
    }
  });

    app.get("/healthcheck", () => {
      return {
        status: "ok",
        port: PORT,
      };
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

        const currentCount = parseInt((await publisher.get(CONNECTION_COUNT_KEY)) || "0", 10);
        const newCount = Math.max(currentCount - connectedClients, 0);

        await publisher.set(CONNECTION_COUNT_KEY, newCount);
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

