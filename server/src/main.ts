import dotenv from "dotenv";
import fastify from "fastify";
import fastifyCors from "@fastify/cors"
import fastifyIO from "fastify-socket.io"
import Redis from "ioredis";
import closeWithGrace from "close-with-grace"

dotenv.config();

const PORT = parseInt(process.env.PORT || "3001", 10);

const HOST = process.env.HOST || "0.0.0.0";

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;

// the channel for the connection count
const CONNECTION_COUNT_KEY = "chat:connection-count";

const CONNECTION_COUNT_UPDATED_CHANNEL = "chat:connection-count-updated";

// check if the UPSTASH_REDIS_REST_URL is set
if (!UPSTASH_REDIS_REST_URL) {
  console.log("Missing UPSTASH_REDIS_REST_URL");
  process.exit(1);
}

// create a publisher for the connection count channel with TLS so that it doesn't throw an error
const publisher = new Redis(UPSTASH_REDIS_REST_URL, {
    tls: {
        rejectUnauthorized: false
    }
});

// create a subscriber for the connection count channel with TLS so that it doesn't throw an error
const subscriber = new Redis(UPSTASH_REDIS_REST_URL, {
    tls: {
        rejectUnauthorized: false
    }
});

let connectedClients = 0;

// build the server & register all the plugins
async function buildServer() {
  const app = fastify();

  // register the cors plugin
  await app.register(fastifyCors, {
    origin: CORS_ORIGIN,
  });

  // register the socket.io plugin
  await app.register(fastifyIO);

  // get the current connection count
  const currentCount = await publisher.get(CONNECTION_COUNT_KEY);

  // set the initial connection count to 0 if it doesn't exist
  if (!currentCount) {
    await publisher.set(CONNECTION_COUNT_KEY, "0");
  }

  // listen to the connection event
  app.io.on("connection", async (io) => {
    console.log("Client connected");

    // increment the connection count
    const incResult = await publisher.incr(CONNECTION_COUNT_KEY);
    connectedClients++;

    // publish the connection count updated event
    await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, incResult.toString());

    // listen to the disconnect event
    io.on('disconnect', async () => {
        console.log("Client disconnected");

        // decrement the connection count
        const decResult = await publisher.decr(CONNECTION_COUNT_KEY);
        connectedClients--;

        // publish the connection count updated event
        await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, decResult.toString());
    })
  });

// subscribe to the connection count updated channel to get the current connection count
subscriber.subscribe(CONNECTION_COUNT_UPDATED_CHANNEL, (err, count) => {
  if (err) {
    console.error(`Error subscribing to ${CONNECTION_COUNT_UPDATED_CHANNEL}: ${err}`); 
    return;
  }

  console.log(`Connection count updated: ${count}`);
})

// listen to the connection count updated channel to get the current connection count
subscriber.on("message", (channel, message) => {
  if (channel === CONNECTION_COUNT_UPDATED_CHANNEL) {

    // emit the connection count updated event to the client
    app.io.emit(CONNECTION_COUNT_UPDATED_CHANNEL, { count: message });
    
    return;
  }
});

  // healthcheck endpoint
  app.get("/healthcheck", () => {
    return {
      status: "OK",
      port: PORT,
      host: HOST,
    };
  });

  return app;
}

// responsible for starting the server
async function main() {
  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server started at http://${HOST}:${PORT}`);

    closeWithGrace({delay: 500}, async () => {
        console.log(`Shutting down server...`)
    })

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

// start the server
main();
