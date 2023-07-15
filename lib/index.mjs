import dgram from "node:dgram";
import {z} from "zod";
import readline from "readline";
import * as uuid from "uuid";

class VectorClock {
    /**
     * @param {number} nodeId
     * @param {Map<string, string>} neighbors
     * */
    constructor(nodeId, neighbors) {
        this.nodeId = nodeId;
        this.neighbors = neighbors;
        this.internalClock = []
    }

    /**
     * @return {Array<number>}
     * */
    get getClock() {
        return this.internalClock;
    }

    get getNodeId() {
        return this.nodeId;
    }

    /**
     * @param {string} destination the node id of the destination
     * */
    increment(destination) {
        const index = Array.from(this.neighbors.keys()).indexOf(destination);
        this.internalClock[index] += 1;
    }

    incrementAll() {
        this.internalClock.forEach((value, index) => {
            this.internalClock[index] += 1;
        });
    }
}

const server = dgram.createSocket("udp4");

const portSchema = z.string().regex(/^((6553[0-5])|(655[0-2][0-9])|(65[0-4][0-9]{2})|(6[0-4][0-9]{3})|([1-5][0-9]{4})|([0-5]{0,5})|([0-9]{1,4}))$/);
const addressSchema = z.string().ip({version: "v4"});

const messageSchema = z.object({
    type: z.enum(["meet", "broadcast", "direct"]),
    payload: z.string(),
});

/**
 * @type {Array<{
 *     type: "meet" | "broadcast" | "direct",
 *     payload: string,
 *     origin?: string,
 *     uuid?: string
 * }>}
 * */
const messages = []

let clientAddress = "";
let clientPort = "";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

/** @type {Map<string, string>} */
const neighbors = new Map();
const vectorClock = new VectorClock(uuid.v4(), neighbors);

function clearLastLine() {
    process.stdout.moveCursor(0, -1) // up one line
    process.stdout.clearLine(1) // from cursor to end
}

function validatePayload(payload) {
    if (!messageSchema.safeParse(payload).success) {
        console.error("Invalid payload");
        return false;
    }

    return true;
}

/**
 * Broadcasts a message to all neighbors
 * @param {{
 *     type: "meet" | "broadcast" | "direct",
 *     payload: string,
 *     origin?: string
 * }} message
 * @returns {void}
 * */
function broadcastMsg(message) {
    if (message.type === "broadcast") {
        for (const [id, info] of neighbors) {
            const payload = JSON.stringify(message);
            const [address, destPort] = info.split(":");
            server.send(payload, Number.parseInt(destPort), address, (err) => {
                if (err) {
                    console.error(err);
                    process.exit(1);
                }
            });

            vectorClock.increment(id);
        }
    }
}

/**
 * Sends a message to a specific neighbor
 * @param {{
 *     type: "meet" | "broadcast" | "direct",
 *     payload: string
 * }} message
 * @param {string} address
 * @param {string} port
 */
function directMsg(message, address, port) {
    if (!addressSchema.safeParse(address).success) {
        console.error("Invalid address");
        return;
    }

    if (!portSchema.safeParse(port).success) {
        console.error("Invalid port number");
        return;
    }

    if (message.type === "direct") {
        const payload = JSON.stringify(message);
        server.send(payload, Number.parseInt(port), address, (err) => {
            if (err) console.error(err);
        });

        for (const [id, info] of neighbors) {
            if (info === `${address}:${port}`) {
                vectorClock.increment(id);
            }
        }
    }
}

/**
 * Adds a neighbor to the list of neighbors
 * @param {string} address
 * @param {string} port
 */
function meet(address, port) {
    const nodeId = uuid.v4();
    const nodeInfo = `${address}:${port}`;

    if (!addressSchema.safeParse(address).success) {
        console.error("Invalid address");
        return;
    }

    if (!portSchema.safeParse(port).success) {
        console.error("Invalid port number");
        return;
    }

    server.connect(Number.parseInt(port), address, (err) => {
        if ([...neighbors.values()].includes(address)) {
            console.error("Already connected to that node");
            server.disconnect();
            return;
        } else {
            neighbors.set(nodeId, nodeInfo);
        }
        server.send(JSON.stringify({
            type: "meet",
            payload: `${port} wants to meet you`,
        }));
        if (err) console.error(err);
        server.disconnect();
    });
}

server.on("error", (err) => {
    console.log(err);
    process.exit(1);
});

server.on("message", (msg, rinfo) => {
    /** @type {{
     *    type: "meet" | "broadcast" | "direct",
     *    payload: string,
     *    origin?: string,
     *    uuid?: string
    }} */
    const payload = JSON.parse(msg.toString());
    let nodeInfo = `${rinfo.address}:${rinfo.port}`;

    if (!validatePayload(payload)) return;

    if (payload.origin && payload.origin === `${server.address().address}:${server.address().port}`) return;

    if (payload.type === "broadcast") {
        if (messages.some((message) => message.uuid === payload.uuid)) {
            return;
        }

        messages.push(payload);

        for (const [id, info] of neighbors) {
            if (info !== payload.origin) {
                broadcastMsg(payload)
            }
        }
        nodeInfo = payload.origin;
        console.log("Broadcast(%s): %s", nodeInfo, payload.payload);
        vectorClock.incrementAll();
    } else if (payload.type === "direct") {
        nodeInfo = payload.origin;
        console.log("Dm(%s): %s", nodeInfo, payload.payload);
        for (const [id, info] of neighbors) {
            if (info === payload.origin) {
                vectorClock.increment(id);
            }
        }
    } else if (payload.type === "meet") {
        if (!neighbors.has(nodeInfo)) {
            neighbors.set(uuid.v4(), nodeInfo);
            console.log("(%s) connected to you", nodeInfo);
        }
    }
});

server.on("close", () => {
    console.log("server closed");
});

server.on("listening", () => {
    const address = server.address();
    console.log(`server listening ${address.address}:${address.port}`);
});

rl.on("line", async (text) => {
    const [command, ...args] = text.split(" ");
    if (command === "meet") {
        meet(args[0], args[1]);
    } else if (command === "dm") {
        const choices = [...neighbors.keys()].map((neighbor) => ({
            title: neighbor,
            value: neighbors.get(neighbor),
        }));

        console.log("Here are your neighbors:");

        choices.forEach((choice) => console.log("%s, %s", choice.title, choice.value));

        rl.question("Who do you want to send a message to? (addr:port)", (response) => {
            const [address, port] = response.split(":");

            rl.question("Type your message: ", (msg) => {
                directMsg({
                    type: "direct",
                    payload: msg,
                    origin: `${server.address().address}:${server.address().port}`
                }, address, port);
                clearLastLine();
                console.log("You sent: %s", msg);
            });
        });
    } else if (command === "broadcast") {
        rl.question("Type your message: ", (msg) => {
            broadcastMsg({
                type: "broadcast",
                payload: msg,
                origin: `${server.address().address}:${server.address().port}`,
                uuid: uuid.v4()
            })
            clearLastLine();
            console.log("You sent: %s", msg);
        });
    }
});


rl.question("enter your address: ", (answer) => {
    rl.question("enter your port: ", (port) => {
        if (!portSchema.safeParse(port).success) {
            console.error("Invalid port number");
            clientPort = port;
            process.exit(1);
        }
        server.bind(Number.parseInt(port), answer);
        clientAddress = answer;
    });
});