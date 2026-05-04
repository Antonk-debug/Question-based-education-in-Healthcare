const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const AiQuizService = require("./ai.js");

const root = __dirname;
const isHostedRuntime = Boolean(process.env.PORT || process.env.RENDER);
const port = Number(process.env.PORT || (process.env.RENDER ? 10000 : 4173));

loadEnvFile(path.join(root, ".env"));

const host = process.env.HOST || (isHostedRuntime ? "0.0.0.0" : "127.0.0.1");
const accessCode = String(process.env.ACCESS_CODE || "").trim();
const defaultModel = "gemini-3.1-flash-lite-preview";
const defaultModels = `${defaultModel},gemini-2.5-flash,gemini-2.5-flash-lite`;
const model = getConfiguredModel();
const models = uniqueModelList(getConfiguredModels(model).split(",").map((item) => item.trim()).filter(Boolean));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);

    if (req.method === "OPTIONS" && isApiPath(url.pathname)) {
      sendNoContent(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, { accessRequired: Boolean(accessCode) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/verify-access") {
      await handleVerifyAccess(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate-quiz") {
      await handleGenerateQuiz(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(url.pathname, res, req.method === "HEAD");
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error" });
  }
});

async function handleVerifyAccess(req, res) {
  const body = await readJsonBody(req);
  if (isAccessAuthorized(req, body)) {
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 401, { error: "Access code is incorrect" });
}

async function handleGenerateQuiz(req, res) {
  const body = await readJsonBody(req);
  if (!isAccessAuthorized(req, body)) {
    sendJson(res, 401, { error: "Enter the access code to use this quiz app" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: "Gemini API key is missing on the backend" });
    return;
  }

  const text = String(body.text || "").trim();
  if (text.length < 40) {
    sendJson(res, 400, { error: "Paste a little more educational text first" });
    return;
  }

  const prompt = [
    AiQuizService._private.buildSystemPrompt(),
    "",
    AiQuizService._private.buildUserPrompt({
      text,
      roundSize: Number(body.roundSize || 5),
      weakAreas: Array.isArray(body.weakAreas) ? body.weakAreas : [],
      previousMistakes: Array.isArray(body.previousMistakes) ? body.previousMistakes : [],
      roundIndex: Number(body.roundIndex || 1),
    }),
  ].join("\n");

  const requestBody = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      responseMimeType: "application/json",
    },
  };

  const geminiResult = await callGeminiWithFallbacks(apiKey, requestBody);

  if (!geminiResult.ok) {
    sendJson(res, geminiResult.status, { error: geminiResult.error });
    return;
  }

  const payload = geminiResult.payload;
  const outputText = AiQuizService._private.extractGeminiText(payload);
  if (!outputText) {
    sendJson(res, 502, { error: "Gemini did not return quiz text" });
    return;
  }

  try {
    const parsed = AiQuizService._private.parseJsonFromText(outputText);
    let normalized;
    try {
      normalized = AiQuizService._private.normalizeAiRound(parsed, Number(body.roundIndex || 1));
    } catch (error) {
      normalized = AiQuizService._private.normalizeAiRound(repairQuizPayload(parsed, text, Number(body.roundSize || 5)), Number(body.roundIndex || 1));
    }
    normalized.questionCount = Number(body.roundSize || normalized.questions.length || 5);
    normalized.modelUsed = geminiResult.modelUsed;
    sendJson(res, 200, normalized);
  } catch (error) {
    sendJson(res, 502, { error: `Gemini returned invalid quiz JSON: ${error.message}` });
  }
}

async function callGeminiWithFallbacks(apiKey, requestBody) {
  const tried = [];
  let lastResult = null;

  for (let index = 0; index < models.length; index += 1) {
    const modelName = models[index];
    tried.push(modelName);
    const result = await callGeminiModel(apiKey, modelName, requestBody);
    if (result.ok) return result;

    lastResult = result;
    if (index < models.length - 1 && isRetryableGeminiError(result)) {
      console.log(`Gemini model ${modelName} failed temporarily: ${result.error}. Trying fallback model.`);
      continue;
    }
    break;
  }

  const triedText = tried.join(", ");
  return {
    ok: false,
    status: lastResult?.status || 502,
    error: `${lastResult?.error || "No Gemini models were available"} Tried models: ${triedText}.`,
  };
}

async function callGeminiModel(apiKey, modelName, requestBody) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.error?.message || `Gemini request failed with status ${response.status}`,
    };
  }

  return {
    ok: true,
    status: response.status,
    payload,
    modelUsed: modelName,
  };
}

function isRetryableGeminiError(result) {
  const message = String(result.error || "").toLowerCase();
  return [429, 500, 502, 503, 504].includes(result.status) || message.includes("high demand") || message.includes("temporarily") || message.includes("unavailable");
}

function isApiPath(pathname) {
  return ["/api/config", "/api/verify-access", "/api/generate-quiz"].includes(pathname);
}

function isAccessAuthorized(req, body) {
  if (!accessCode) return true;
  const provided = String(req.headers["x-access-code"] || body?.accessCode || "").trim();
  return provided === accessCode;
}

function uniqueModelList(modelList) {
  const seen = new Set();
  return modelList.filter((modelName) => {
    const key = modelName.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getConfiguredModel() {
  const configuredModel = String(process.env.GEMINI_MODEL || "").trim();
  return !configuredModel || configuredModel === "gemini-2.5-flash" ? defaultModel : configuredModel;
}

function getConfiguredModels(primaryModel) {
  const configuredModels = String(process.env.GEMINI_MODELS || "").trim();
  if (!configuredModels || configuredModels === "gemini-2.5-flash,gemini-2.5-flash-lite") {
    return primaryModel === defaultModel ? defaultModels : `${primaryModel},gemini-2.5-flash,gemini-2.5-flash-lite`;
  }
  return configuredModels;
}

function repairQuizPayload(payload, sourceText, expectedCount) {
  if (!payload || !Array.isArray(payload.questions)) {
    throw new Error("The AI response had the wrong quiz shape");
  }

  const sourceTerms = extractSourceTerms(sourceText);
  const questions = payload.questions.slice(0, expectedCount).map((question, index) => {
    const rawOptions = Array.isArray(question.options) ? question.options.map(cleanText).filter(Boolean) : [];
    let correctIndex = Number(question.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= rawOptions.length) correctIndex = 0;
    const correctOption = rawOptions[correctIndex] || `Correct source idea ${index + 1}`;
    const options = uniqueByKey([correctOption].concat(rawOptions), normalizeKey);
    let fillerIndex = 1;
    while (options.length < 5) {
      const filler = buildFillerOption(question, sourceTerms, fillerIndex);
      fillerIndex += 1;
      if (!options.some((option) => normalizeKey(option) === normalizeKey(filler))) options.push(filler);
    }
    return {
      area: cleanText(question.area) || `Source concept ${index + 1}`,
      skillTag: cleanText(question.skillTag) || "Comprehension",
      mapTopic: cleanMapTopic(question.mapTopic || question.skillTag || question.area || `Q${index + 1}`),
      question: cleanText(question.question) || `Which answer best matches source concept ${index + 1}?`,
      options: options.slice(0, 5),
      correctIndex: 0,
      explanation: cleanText(question.explanation) || "The correct answer follows directly from the source text.",
      sourceQuote: cleanText(question.sourceQuote) || sourceText.slice(0, 180),
    };
  });

  while (questions.length < expectedCount) {
    questions.push(buildFallbackQuestion(questions.length, sourceText, sourceTerms));
  }

  if (questions.length !== expectedCount) {
    throw new Error(`Could not repair the AI response into exactly ${expectedCount} questions`);
  }

  return {
    coverageSummary: cleanText(payload.coverageSummary) || "Generated from the source text.",
    questionCount: expectedCount,
    questions,
  };
}

function buildFallbackQuestion(index, sourceText, sourceTerms) {
  const term = sourceTerms[index % sourceTerms.length] || `source concept ${index + 1}`;
  return {
    area: titleCase(term),
    skillTag: "Comprehension",
    mapTopic: cleanMapTopic(term),
    question: `Which answer is best supported by the source text about ${term}?`,
    options: [
      `The source directly supports the key point about ${term}`,
      `A plausible but unsupported claim about ${term}`,
      `A reversed relationship involving ${term}`,
      "A broader statement than the source text supports",
      "A detail from the source that does not answer this question",
    ],
    correctIndex: 0,
    explanation: "The correct answer is the option most directly supported by the supplied source text.",
    sourceQuote: sourceText.slice(0, 180),
  };
}

function extractSourceTerms(sourceText) {
  const stopWords = new Set(["about", "after", "because", "before", "between", "could", "during", "every", "from", "have", "into", "more", "most", "other", "that", "their", "there", "these", "they", "this", "those", "through", "where", "which", "while", "with", "would"]);
  const seen = new Set();
  return (String(sourceText).match(/[A-Za-z][A-Za-z'-]{3,}/g) || [])
    .filter((word) => {
      const key = word.toLowerCase();
      if (stopWords.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function buildFillerOption(question, sourceTerms, index) {
  const area = cleanText(question.area) || "the topic";
  const term = sourceTerms[(index - 1) % sourceTerms.length] || area;
  const templates = [
    `A plausible but unsupported claim about ${term}`,
    `A reversed relationship involving ${area}`,
    "A broader statement than the source text supports",
    "A detail from the source that does not answer this question",
    "A partly true statement that misses the key condition",
  ];
  return templates[(index - 1) % templates.length];
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanMapTopic(value) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  return words.slice(0, 3).join(" ") || "Topic";
}

function normalizeKey(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleCase(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function serveStatic(pathname, res, headOnly) {
  const safePathname = pathname === "/" ? getHomePagePathname() : decodeURIComponent(pathname);
  const filePath = path.resolve(root, `.${safePathname}`);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (filePath !== root && !filePath.startsWith(rootPrefix)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
    });

    if (!headOnly) res.end(data);
    else res.end();
  });
}

function getHomePagePathname() {
  return fs.existsSync(path.join(root, "Adaptive Quiz Studio.html")) ? "/Adaptive Quiz Studio.html" : "/index.html";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_200_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
  });
  res.end(JSON.stringify(payload));
}

function sendNoContent(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
  });
  res.end();
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) return;
    const key = trimmed.slice(0, equalsIndex).trim().replace(/^\uFEFF/, "");
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`Adaptive Quiz Studio is running at http://${displayHost}:${port}/`);
});
