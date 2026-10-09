"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// The journal contains order metadata only. Broker credentials are never accepted here.
class OrderStore {
  constructor(filePath = path.join(__dirname, "data", "orders.jsonl")) {
    this.filePath = filePath;
    this.records = new Map();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let contents;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    const lines = contents.split("\n");
    let incompleteTail = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record.id !== "string" || typeof record.idempotencyKey !== "string") {
          throw new Error("invalid order record");
        }
        this.records.set(record.id, record);
      } catch (cause) {
        // A final partial line can result from a power loss during append. Earlier
        // corruption fails startup so the service cannot silently forget orders.
        if (index === lines.length - 1 && !contents.endsWith("\n")) {
          incompleteTail = true;
          break;
        }
        throw new Error(`Order journal is invalid at line ${index + 1}.`, { cause });
      }
    }

    if (!contents.endsWith("\n")) {
      if (incompleteTail) {
        const lastNewline = contents.lastIndexOf("\n");
        await fs.truncate(this.filePath, Buffer.byteLength(contents.slice(0, lastNewline + 1), "utf8"));
      } else {
        await fs.appendFile(this.filePath, "\n", "utf8");
      }
    }

    for (const record of this.records.values()) {
      if (record.status === "pending") {
        record.status = "unknown";
        record.updatedAt = new Date().toISOString();
        record.responseStatus = 502;
        record.responseBody = { error: "The service restarted while this order was in progress. Reconcile it before retrying.", code: "ORDER_OUTCOME_UNKNOWN", orderId: record.id };
        await this.save(record);
      }
    }
  }

  async save(record) {
    const line = `${JSON.stringify(record)}\n`;
    const operation = this.writeQueue.then(async () => {
      const handle = await fs.open(this.filePath, "a");
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.records.set(record.id, structuredClone(record));
    });
    this.writeQueue = operation.catch(() => {});
    await operation;
    return record;
  }

  getByIdempotencyKey(key) {
    for (const record of this.records.values()) {
      if (record.idempotencyKey === key) return structuredClone(record);
    }
    return null;
  }

  get(id) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  hasUnresolved() {
    return [...this.records.values()].some((record) => ["pending", "unknown"].includes(record.status));
  }

  list(limit = 200) {
    const sorted = [...this.records.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const selected = new Map(sorted.slice(0, limit).map((record) => [record.id, record]));
    for (const record of sorted) {
      if (["pending", "unknown"].includes(record.status)) selected.set(record.id, record);
    }
    return [...selected.values()].map((record) => structuredClone(record));
  }
}

module.exports = OrderStore;
