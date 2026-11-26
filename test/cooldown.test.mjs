// Failover, cool-down and the Alibaba adapter against a stubbed network, so it does not depend on any
// provider being up or down on the day. Run with: node test/cooldown.test.mjs

globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const ALIBABA = "translate.alibaba.com";
const CSRF = { token: "t1", parameterName: "_csrf", headerName: "X-XSRF-TOKEN" };
const alibabaReply = (translateText) =>
  Response.json({ success: true, data: { translateText, detectLanguage: "zh" } });

// Alibaba is down (the connection is refused); Google answers with whatever it was sent.
let alibabaDown = true;
const calls = [];
globalThis.fetch = async (url, options) => {
  const { host, pathname } = new URL(url);
  calls.push(host);
  if (host === ALIBABA) {
    if (alibabaDown) throw new TypeError("Failed to fetch");
    if (pathname.endsWith("/csrftoken")) return Response.json(CSRF);
    return alibabaReply(options.body.get("query"));
  }
  if (host === "translate-pa.googleapis.com") {
    const [[texts]] = JSON.parse(options.body);
    return Response.json([texts, texts.map(() => "zh-CN")]);
  }
  throw new TypeError(`unexpected host ${host}`);
};

const { translate } = await import("../src/background.js");
const { usableProviders } = await import("../src/lib/settings.js");
const ORDER = ["alibaba", "google", "mymemory"];

console.log("a provider that is down falls through to the next");
calls.length = 0;
const first = await translate(["你好"], "en", ORDER);
check("google served it", first.provider === "google", first.provider);
check("alibaba was tried first", calls[0] === ALIBABA, calls.join(","));
check("and is reported as failed", first.failed?.[0]?.id === "alibaba", JSON.stringify(first.failed));
check("with the reason", /unreachable/.test(first.failed?.[0]?.reason), first.failed?.[0]?.reason);
check("total covers the whole wait", first.total >= first.ms, `${first.total} < ${first.ms}`);

console.log("\nwhile it cools down it is not tried again");
calls.length = 0;
const second = await translate(["再见"], "en", ORDER);
check("google served it", second.provider === "google", second.provider);
check("alibaba was not called", !calls.includes(ALIBABA), calls.join(","));
check("and is reported as skipped", /^skipped/.test(second.failed?.[0]?.reason), JSON.stringify(second.failed));
check("since the first failure", typeof second.failed?.[0]?.since === "number");

console.log("\na resting provider is still tried when it is the only one left");
alibabaDown = false;
calls.length = 0;
const forced = await translate(["你好"], "en", "alibaba");
check("alibaba served it", forced.provider === "alibaba", forced.provider);
check("with nothing reported as failed", forced.failed?.length === 0, JSON.stringify(forced.failed));

console.log("\nand answering ends the cool-down");
calls.length = 0;
const back = await translate(["你好"], "en", ORDER);
check("alibaba is first again", back.provider === "alibaba" && calls[0] === ALIBABA, calls.join(","));

console.log("\nalibaba: one request per text, and its own spelling of a marker folded back");
const sentQueries = [];
globalThis.fetch = async (url, options) => {
  const { pathname } = new URL(url);
  if (pathname.endsWith("/csrftoken")) return Response.json(CSRF);
  const query = options.body.get("query");
  sentQueries.push({ query, tgt: options.body.get("tgtLang") });
  return alibabaReply(query.replace("<b0>", "<B0> ").replace("</b1>", "</b1 >"));
};
const pair = await translate(["<b0>甲</b0><b1>乙</b1>", "甲乙"], "zh-Hant", "alibaba");
check("both texts went out on their own", sentQueries.length === 2, JSON.stringify(sentQueries));
check("zh-Hant is sent as zh-tw", sentQueries.every((q) => q.tgt === "zh-tw"), JSON.stringify(sentQueries));
check("markers come back as sent", pair.texts[0] === "<b0> 甲</b0><b1>乙</b1>", pair.texts[0]);
const reason = await translate(["这".repeat(5001)], "en", "alibaba").then(() => "", (e) => e.message);
check("past 5000 characters it refuses without a request", /character limit/.test(reason), reason);

console.log("\nalibaba: a token it stopped accepting is replaced once");
let tokens = 1;
globalThis.fetch = async (url, options) => {
  const { pathname } = new URL(url);
  if (pathname.endsWith("/csrftoken")) return Response.json({ ...CSRF, token: `t${++tokens}` });
  if (options.body.get("_csrf") === "t1") return new Response("<!DOCTYPE html><html></html>");
  return alibabaReply("hello");
};
// Same module, so the token cached above (t1) is the one that gets refused here.
const retried = await translate(["你好"], "en", "alibaba");
check("translated with a fresh token", retried.provider === "alibaba" && retried.texts[0] === "hello", JSON.stringify(retried));

console.log("\na refusal is about the text, not the service, so it does not cool down");
globalThis.fetch = async (url) => {
  const { host, pathname } = new URL(url);
  calls.push(host);
  if (host === ALIBABA) {
    if (pathname.endsWith("/csrftoken")) return Response.json(CSRF);
    return Response.json({ success: false, code: "TranslateFailed" });
  }
  return Response.json([["x"], ["zh-CN"]]);
};
await translate(["你好"], "en", ORDER);
calls.length = 0;
await translate(["你好"], "en", ORDER);
check("alibaba is still tried first", calls[0] === ALIBABA, calls.join(","));

console.log("\na saved order that names Tencent gets Alibaba in its place");
check("tencent first becomes alibaba first",
  JSON.stringify(usableProviders(["tencent", "google", "mymemory"])) === JSON.stringify(ORDER));
check("and is not listed twice",
  JSON.stringify(usableProviders(["google", "tencent", "alibaba"])) === JSON.stringify(["google", "alibaba"]));

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
