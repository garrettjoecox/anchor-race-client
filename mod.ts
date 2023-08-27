import { writeAll } from "https://deno.land/std@0.192.0/streams/write_all.ts";
import { readLines } from "https://deno.land/std@0.193.0/io/read_lines.ts";

const sohConfigString = await Deno.readTextFile("./shipofharkinian.json");
const sohConfig = JSON.parse(sohConfigString);
const flattenObject = (obj: Record<string, any>, prefix = "") =>
  Object.keys(obj).reduce((acc, k) => {
    const pre = prefix.length ? prefix + "." : "";
    if (typeof obj[k] === "object") {
      Object.assign(acc, flattenObject(obj[k], pre + k));
    } else acc[pre + k] = obj[k];
    return acc;
  }, {} as Record<string, any>);
const sohCVars = flattenObject(sohConfig.CVars);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type ClientData = Record<string, any>;

interface BasePacket {
  clientId?: number;
  roomId?: string;
  quiet?: boolean;
  targetClientId?: number;
}

interface UpdateClientDataPacket extends BasePacket {
  type: "UPDATE_CLIENT_DATA";
  data: ClientData;
}

interface SetConfigPacket extends BasePacket {
  type: "RESET";
}

interface AllClientDataPacket extends BasePacket {
  type: "ALL_CLIENT_DATA";
  clients: ClientData[];
}

interface ServerMessagePacket extends BasePacket {
  type: "SERVER_MESSAGE";
  message: string;
}

interface DisableAnchorPacket extends BasePacket {
  type: "DISABLE_ANCHOR";
}

interface OtherPackets extends BasePacket {
  type: "REQUEST_SAVE_STATE" | "PUSH_SAVE_STATE";
}

type Packet =
  | UpdateClientDataPacket
  | SetConfigPacket
  | DisableAnchorPacket
  | ServerMessagePacket
  | AllClientDataPacket
  | OtherPackets;

class Client {
  public id: number;
  public data: ClientData = {};
  private connection: Deno.Conn;

  constructor(connection: Deno.Conn) {
    this.connection = connection;
    this.id = connection.rid;

    this.log("Connected");
    this.waitForData();
  }

  async waitForData() {
    const buffer = new Uint8Array(1024);
    let data = new Uint8Array(0);

    while (true) {
      let count: null | number = 0;

      try {
        count = await this.connection.read(buffer);
      } catch (error) {
        this.log(`Error reading from connection: ${error.message}`);
        this.disconnect();
        break;
      }

      if (!count) {
        this.disconnect();
        break;
      }

      // Concatenate received data with the existing data
      const receivedData = buffer.subarray(0, count);
      data = concatUint8Arrays(data, receivedData);

      // Handle all complete packets (while loop in case multiple packets were received at once)
      while (true) {
        const delimiterIndex = findDelimiterIndex(data);
        if (delimiterIndex === -1) {
          break; // Incomplete packet, wait for more data
        }

        // Extract the packet
        const packet = data.subarray(0, delimiterIndex + 1);
        data = data.subarray(delimiterIndex + 1);

        this.handlePacket(packet);
      }
    }
  }

  handlePacket(packet: Uint8Array) {
    try {
      const packetString = decoder.decode(packet);
      const packetObject: Packet = JSON.parse(packetString);

      if (!packetObject.quiet) {
        this.log(`-> ${packetObject.type} packet`);
      }

      switch (packetObject.type) {
        case "UPDATE_CLIENT_DATA": {
          if (!this.data[packetObject.clientId!]) {
            // New client, reset if they have a save loaded
            if (packetObject.data.fileNum !== 255) {
              this.sendPacket({
                type: "SERVER_MESSAGE",
                message: "Can't connect with save loaded, resetting",
                targetClientId: packetObject.clientId,
              })
                .finally(() =>
                  this.sendPacket({
                    type: "RESET",
                    targetClientId: packetObject.clientId,
                  })
                );
            }
          } else {
            // Existing client, reset if they load into the wrong seed
            if (
              packetObject.data.fileNum !== 255 &&
              packetObject.data.seed !== config.seed
            ) {
              this.sendPacket({
                type: "SERVER_MESSAGE",
                message: "Wrong seed loaded, resetting",
                targetClientId: packetObject.clientId,
              })
                .finally(() =>
                  this.sendPacket({
                    type: "RESET",
                    targetClientId: packetObject.clientId,
                  })
                );
            }
          }
          this.data[packetObject.clientId!] = packetObject.data;
          break;
        }
        case "ALL_CLIENT_DATA": {
          packetObject.clients.forEach(({ clientId, ...data }) => {
            if (this.data[clientId]) {
              this.data[clientId] = data;
            }
          });
          break;
        }
      }
    } catch (error) {
      this.log(`Error handling packet: ${error.message}`);
    }
  }

  async sendPacket(packetObject: Packet) {
    try {
      if (!packetObject.quiet) {
        this.log(`<- ${packetObject.type} packet`);
      }
      const packetString = JSON.stringify(packetObject);
      const packet = encoder.encode(packetString + "\n");

      await writeAll(this.connection, packet);
    } catch (error) {
      this.log(`Error sending packet: ${error.message}`);
      this.disconnect();
    }
  }

  disconnect() {
    try {
      this.connection.close();
    } catch (error) {
      this.log(`Error disconnecting: ${error.message}`);
    } finally {
      this.log("Disconnected");
    }
  }

  log(message: string) {
    console.log(`[Host Client]: ${message}`);
  }
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function findDelimiterIndex(data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 10 /* newline character */) {
      return i;
    }
  }
  return -1;
}

type RaceMode = "KICKOFF" | "ONGOING";

const config = {
  room: crypto.randomUUID(),
  seed: crypto.randomUUID(),
  mode: "KICKOFF" as RaceMode,
  hostname: "anchor.proxysaw.dev",
  port: 43384,
};

// Override config with arguments if provided
if (Deno.args.length > 0) {
  Deno.args.forEach((arg) => {
    const [key, value] = arg.split("=");
    if (!key || !value || !(key in config)) {
      throw new Error(
        `Invalid argument: ${arg}, must be KEY=VALUE of ${
          Object.keys(config).join(", ")
        }`,
      );
    }

    if (key === "mode" && !["KICKOFF", "ONGOING"].includes(value)) {
      throw new Error(`Invalid mode: ${value}, must be KICKOFF or ONGOING`);
    }

    // @ts-expect-error allow dynamic key access
    config[key] = value;
  });
}

console.log("Config:", config);

const conn = await Deno.connect({
  hostname: config.hostname,
  port: config.port,
  transport: "tcp",
});

const client = new Client(conn);
client.sendPacket({
  type: "UPDATE_CLIENT_DATA",
  roomId: config.room,
  data: {
    name: "HOST",
    clientVersion: "Anchor Race Build 1",
    seed: config.seed,
    config: sohCVars,
  },
});

(async () => {
  try {
    for await (const line of readLines(Deno.stdin)) {
      const [command, ...args] = line.split(" ");

      switch (command) {
        default:
        case "help": {
          console.log(
            `Available commands:
  help: Show this help message`,
          );
          break;
        }
        case "reset": {
          client.sendPacket({
            type: "RESET",
            roomId: config.room,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error readingt from stdin: ", error.message);
  }
})();
