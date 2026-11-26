// Hits the live free providers. Run with: node test/remote.test.mjs
// The point is that numbered <bN> tags survive every provider intact, since the whole
// structure-preserving scheme rests on that being true.

globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };

const { translate, viaTranslateHtml, viaGtx } = await import("../src/background.js");
const { unescapeEntities } = await import("../src/lib/entities.js");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const TAGGED = "<b0>这是一段</b0>简体中文的<b1>测试文字</b1>，请仔细阅读。";
const CELL =
  "<b0><b1></b1><b2>2026-07-23</b2></b0><b3><b4>订单号</b4><b5>: </b5><b6>3313704182876019697</b6></b3>";

const tagsIn = (text) => (text.match(/<\/?b\d+>/g) || []).length;

console.log("unescapeEntities");
check("entities become characters", unescapeEntities("a &lt;b&gt; &amp; &#39;c&#39;") === "a <b> & 'c'");
check("fullwidth percent escapes are handled", unescapeEntities("x ％3Cy％3E") === "x <y>");

for (const provider of ["google", "alibaba", "mymemory"]) {
  console.log(`\n${provider}: numbered tags survive`);
  try {
    const { texts, provider: used } = await translate([TAGGED], "en", provider);
    console.log("   ->", JSON.stringify(texts[0]));
    check(`${provider} answered`, used === provider);
    check(`${provider} returns all four tags`, tagsIn(texts[0]) === 4, texts[0]);
    check(`${provider} kept both pairs balanced`,
      /<b0>[\s\S]*<\/b0>/.test(texts[0]) && /<b1>[\s\S]*<\/b1>/.test(texts[0]), texts[0]);
    check(`${provider} actually translated`, /read|chinese|text/i.test(texts[0]), texts[0]);
  } catch (error) {
    check(`${provider} answered`, false, String(error.message).slice(0, 160));
  }
}

console.log("\nempty pairs keep opaque content out of the request");
{
  const { texts } = await translate([CELL], "en", "google");
  console.log("   ->", JSON.stringify(texts[0]));
  check("all seven elements come back, opened and closed", tagsIn(texts[0]) === 14, texts[0]);
  check("the empty pair is intact", texts[0].includes("<b1></b1>"), texts[0]);
  check("the date is untouched", texts[0].includes("2026-07-23"), texts[0]);
  check("the order number is untouched", texts[0].includes("3313704182876019697"), texts[0]);
}

console.log("\ngoogle: batching and per-item detection");
{
  const { texts, detected } = await viaTranslateHtml(
    ["这是一段简体中文的测试文字。", "これは日本語のテスト用の段落です。", "Это тестовый абзац."],
    "auto",
    "en",
  );
  console.log("   ->", JSON.stringify(texts));
  check("three results", texts.length === 3);
  check("all ascii output", texts.every((t) => /^[\x20-\x7e‘’“”]+$/.test(t)), JSON.stringify(texts));
  check("per-item detection", JSON.stringify(detected) === '["zh-CN","ja","ru"]', JSON.stringify(detected));
}

console.log("\ngoogle: the gtx backup endpoint");
{
  const single = await viaGtx(["Dies ist ein deutscher Testabsatz."], "auto", "en");
  check("single input parses", /German test/i.test(single.texts[0]), single.texts[0]);
  check("single input reports language", single.detected[0] === "de", JSON.stringify(single.detected));
  const multi = await viaGtx(["Ceci est un test <b0>rouge</b0>.", "deuxième"], "auto", "en");
  check("multi input parses", multi.texts.length === 2);
  check("tags survive the backup too", /<b0>[\s\S]*<\/b0>/.test(multi.texts[0]), multi.texts[0]);
}

console.log("\nalibaba: one request per text, and source language");
{
  const { texts, detected } = await translate(
    ["这是一段简体中文的测试文字。", "另一段中文。"], "en", "alibaba");
  check("both items come back", texts.length === 2, JSON.stringify(texts));
  check("source language is reported", /^zh/.test(detected?.[0] || ""), JSON.stringify(detected));
}

console.log("\nfailover: an unknown provider name falls back to trying them all");
{
  const { texts, provider } = await translate(["这是一段简体中文的测试文字。"], "en", "ondevice");
  check("a retired setting still translates", /chinese|test/i.test(texts[0]), texts[0]);
  check("and reports which provider served it", ["google", "alibaba", "mymemory"].includes(provider), provider);
}

console.log("\nmymemory: refuses what it cannot do rather than returning rubbish");
{
  const reason = async (texts) => {
    try {
      await translate(texts, "en", "mymemory");
      return "";
    } catch (error) {
      return error.message;
    }
  };
  const tooLong = await reason(["这".repeat(600)]);
  check("over-long text is refused with a clear reason", /character limit/.test(tooLong), tooLong);
  const noSource = await reason(["a latin sentence with no script to go on"]);
  check("undetectable source is refused with a clear reason",
    /source language/.test(noSource), noSource);
}

console.log("\nalibaba: limits and marker spelling");
{
  const reason = async (texts) => {
    try {
      await translate(texts, "en", "alibaba");
      return "";
    } catch (error) {
      return error.message;
    }
  };
  const tooLong = await reason(["这".repeat(5001)]);
  check("text past 5000 characters is refused before it is sent", /character limit/.test(tooLong), tooLong);
  const atLimit = await translate(["这是一段中文。".repeat(700)], "en", "alibaba");
  check("text at the limit is translated", atLimit.provider === "alibaba" && /[a-z]/i.test(atLimit.texts[0]));
  // Traditional Chinese is where it writes a marker as <B0>; the adapter folds it back.
  const hant = await translate(["<b0>這是一段</b0>繁體中文的<b1>測試文字</b1>。"], "en", "alibaba");
  check("markers come back in the one spelling the parser knows", tagsIn(hant.texts[0]) === 4, hant.texts[0]);
  const toHant = await translate(["<b0>Click here</b0> to read more."], "zh-Hant", "alibaba");
  check("zh-Hant is accepted as a target", /[一-鿿]/.test(toHant.texts[0]), toHant.texts[0]);
}

console.log("\na long block still goes to the first provider in the order");
{
  const text = "这是一段比较长的中文文字，用来测试长度。".repeat(60);
  const long = await translate([`<b0>${text}</b0>`, text], "en", ["alibaba", "google", "mymemory"]);
  check("alibaba served it", long.provider === "alibaba", long.provider);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
