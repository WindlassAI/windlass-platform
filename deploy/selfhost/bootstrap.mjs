// A fresh engine needs a namespace and a pool before the node connects.
import { setTimeout as delay } from "node:timers/promises";

async function request(path, method = "GET", body) {
  return fetch(process.env.RIVET_ENDPOINT + path, {
    method, redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { authorization: "Bearer " + process.env.RIVET_TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

for (let attempt = 1; ; attempt++) {
  try {
    const list = await request("/namespaces?name=default");
    if (!list.ok) throw Error("namespace lookup HTTP " + list.status);
    if (!(await list.json()).namespaces.some(ns => ns.name === "default")) {
      const created = await request("/namespaces", "POST", { name: "default" });
      if (!created.ok) throw Error("namespace creation HTTP " + created.status);
    }
    const path = "/pools/default?namespace=default";
    const pool = await request(path);
    if (pool.status === 404) {
      const created = await request(path, "PUT", {});
      if (!created.ok) throw Error("pool creation HTTP " + created.status);
    } else if (!pool.ok) throw Error("pool lookup HTTP " + pool.status);
    break;
  } catch (error) {
    if (attempt >= 90) throw error;
    if (attempt % 10 === 0) console.error("Waiting for engine:", error.message);
    await delay(1000);
  }
}
