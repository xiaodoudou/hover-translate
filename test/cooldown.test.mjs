// Failover and cool-down against a stubbed network, so it does not depend on any provider being up
// or down on the day. Run with: node test/cooldown.test.mjs

globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// TranSmart is down (the connection is refused); Google answers with whatever it was sent.
let tencentDown = true;
const calls = [];
globalThis.fetch = async (url, options) => {
  const host = new URL(url).host;
  calls.push(host);
  if (host === "transmart.qq.com") {
    if (tencentDown) throw new TypeError("Failed to fetch");
    const texts = JSON.parse(options.body).source.text_list;
    return Response.json({ header: { ret_code: "succ" }, auto_translation: texts, src_lang: "zh" });
  }
  if (host === "translate-pa.googleapis.com") {
    const [[texts]] = JSON.parse(options.body);
    return Response.json([texts, texts.map(() => "zh-CN")]);
  }
  throw new TypeError(`unexpected host ${host}`);
};

const { translate } = await import("../src/background.js");
const ORDER = ["tencent", "google", "mymemory"];

console.log("a provider that is down falls through to the next");
calls.length = 0;
const first = await translate(["你好"], "en", ORDER);
check("google served it", first.provider === "google", first.provider);
check("tencent was tried first", calls[0] === "transmart.qq.com", calls.join(","));
check("and is reported as failed", first.failed?.[0]?.id === "tencent", JSON.stringify(first.failed));
check("with the reason", /unreachable/.test(first.failed?.[0]?.reason), first.failed?.[0]?.reason);
check("total covers the whole wait", first.total >= first.ms, `${first.total} < ${first.ms}`);

console.log("\nwhile it cools down it is not tried again");
calls.length = 0;
const second = await translate(["再见"], "en", ORDER);
check("google served it", second.provider === "google", second.provider);
check("tencent was not called", !calls.includes("transmart.qq.com"), calls.join(","));
check("and is reported as skipped", /^skipped/.test(second.failed?.[0]?.reason), JSON.stringify(second.failed));
check("since the first failure", typeof second.failed?.[0]?.since === "number");

console.log("\na resting provider is still tried when it is the only one left");
tencentDown = false;
calls.length = 0;
const forced = await translate(["你好"], "en", "tencent");
check("tencent served it", forced.provider === "tencent", forced.provider);
check("with nothing reported as failed", forced.failed?.length === 0, JSON.stringify(forced.failed));

console.log("\nand answering ends the cool-down");
calls.length = 0;
const back = await translate(["你好"], "en", ORDER);
check("tencent is first again", back.provider === "tencent" && calls[0] === "transmart.qq.com", calls.join(","));

console.log("\na refusal is about the text, not the service, so it does not cool down");
globalThis.fetch = async (url) => {
  const host = new URL(url).host;
  calls.push(host);
  if (host === "transmart.qq.com") return Response.json({ header: { ret_code: "outOfLimit" } });
  return Response.json([["x"], ["zh-CN"]]);
};
await translate(["你好"], "en", ORDER);
calls.length = 0;
await translate(["你好"], "en", ORDER);
check("tencent is still tried first", calls[0] === "transmart.qq.com", calls.join(","));

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
