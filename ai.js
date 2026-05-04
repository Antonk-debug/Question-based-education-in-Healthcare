(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.AiQuizService = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const ACCESS_CODE_KEY = "adaptiveQuizAccessCode";

  async function generateQuiz(options) {
    const settings = Object.assign(
      {
        text: "",
        roundSize: 5,
        weakAreas: [],
        previousMistakes: [],
        roundIndex: 1,
      },
      options || {},
    );

    let response;
    try {
      response = await fetch(getBackendUrl("/api/generate-quiz"), {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(settings),
      });
    } catch (error) {
      throw new Error("Could not reach the quiz backend. If you are running it locally, start the local backend shortcut and keep its window open.");
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload?.error || `Backend request failed with status ${response.status}`;
      throw requestError(message, response.status);
    }

    return normalizeAiRound(payload, settings.roundIndex);
  }

  async function getConfig() {
    const response = await fetch(getBackendUrl("/api/config"));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw requestError(payload?.error || "Could not load app settings", response.status);
    }
    return payload;
  }

  async function verifyAccessCode(accessCode) {
    const cleanCode = cleanText(accessCode);
    const response = await fetch(getBackendUrl("/api/verify-access"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: cleanCode }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw requestError(payload?.error || "Access code is incorrect", response.status);
    }
    setAccessCode(cleanCode);
    return payload;
  }

  function getBackendUrl(path) {
    const apiPath = path || "/api/generate-quiz";
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      return `http://127.0.0.1:4173${apiPath}`;
    }
    return apiPath;
  }

  function getRequestHeaders() {
    const headers = { "Content-Type": "application/json" };
    const accessCode = getAccessCode();
    if (accessCode) headers["X-Access-Code"] = accessCode;
    return headers;
  }

  function getAccessCode() {
    if (typeof window === "undefined" || !window.sessionStorage) return "";
    return window.sessionStorage.getItem(ACCESS_CODE_KEY) || "";
  }

  function setAccessCode(accessCode) {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    window.sessionStorage.setItem(ACCESS_CODE_KEY, cleanText(accessCode));
  }

  function requestError(message, status) {
    const error = new Error(message);
    error.status = status;
    error.accessDenied = status === 401 || status === 403;
    return error;
  }

  function buildSystemPrompt() {
    return [
      "You are an expert teacher and assessment designer.",
      "Generate exactly the requested number of multiple-choice questions from the supplied educational text.",
      "Detect the dominant language of the supplied source text.",
      "Write every learner-facing string in the same language as the source text, including coverageSummary, area, skillTag, question, options, explanation, sourceQuote, and mapTopic.",
      "Keep JSON property names in English exactly as specified, but do not default the quiz content to English unless the source text is English.",
      "If the source text mixes languages, use the dominant language while preserving names, technical terms, and quoted phrases as they appear in the source.",
      "Each question must have exactly five answer options.",
      "correctIndex must be a zero-based number from 0 to 4.",
      "Each question must have exactly one correct option.",
      "The correct answer must not be identical to the question.",
      "All four incorrect options must be clearly wrong, incomplete, or unsupported by the source text.",
      "Do not include any distractor that could reasonably be accepted as another correct answer.",
      "Questions should be tricky but fair: distractors should be plausible misconceptions based on the text, not silly or obviously unrelated.",
      "Use only the supplied source text. Do not add outside facts.",
      "Avoid all-of-the-above, none-of-the-above, joke answers, and answer options that are duplicated or nearly duplicated.",
      "For adaptive rounds, focus most questions on the weak areas and mistakes provided.",
      "Include the requested number as questionCount in the JSON response.",
      "Return only valid JSON matching this shape: {\"coverageSummary\":\"string\",\"questionCount\":5,\"questions\":[{\"area\":\"string\",\"skillTag\":\"string\",\"question\":\"string\",\"options\":[\"string\",\"string\",\"string\",\"string\",\"string\"],\"correctIndex\":0}]}",
    ].join(" ");
  }

  function buildUserPrompt(settings) {
    const weakAreas = settings.weakAreas?.length ? settings.weakAreas.join(", ") : "None yet";
    const mistakes = settings.previousMistakes?.length
      ? settings.previousMistakes
          .slice(-8)
          .map((item, index) => `${index + 1}. Area: ${item.area}. Question: ${item.prompt}. Correct: ${item.correct}. Chosen: ${item.chosen || "No answer"}.`)
          .join("\n")
      : "No previous mistakes.";

    return [
      `Round: ${settings.roundIndex || 1}`,
      `Number of questions to generate: ${settings.roundSize || 5}`,
      `Weak areas: ${weakAreas}`,
      "Previous mistakes:",
      mistakes,
      "Source text:",
      settings.text,
      "Output language: use the same dominant language as the source text for all visible quiz content.",
      "Generate the next quiz round now.",
    ].join("\n\n");
  }

  function normalizeAiRound(payload, roundIndex) {
    if (!payload || !Array.isArray(payload.questions)) {
      throw new Error("The AI response had the wrong quiz shape");
    }

    if (isAppReadyRound(payload)) {
      return validateAppReadyRound(payload, roundIndex);
    }

    const expectedCount = getExpectedQuestionCount(payload, roundIndex);
    const questions = payload.questions.slice(0, expectedCount).map((question, index) => {
      const rawOptions = Array.isArray(question.options) ? question.options.map(cleanText).filter(Boolean).slice(0, 5) : [];
      const correctIndex = Number(question.correctIndex);

      if (rawOptions.length !== 5 || correctIndex < 0 || correctIndex > 4) {
        throw new Error("The AI returned a question without exactly five valid options");
      }

      const correctText = rawOptions[correctIndex];
      const options = uniqueByKey(rawOptions, normalizeKey);
      const normalizedCorrectIndex = options.findIndex((option) => normalizeKey(option) === normalizeKey(correctText));

      if (options.length !== 5 || normalizedCorrectIndex < 0) {
        throw new Error("The AI returned duplicate options or an invalid answer index");
      }

      if (hasNearDuplicateCorrectOption(options, normalizedCorrectIndex)) {
        throw new Error("The AI returned another option too similar to the correct answer");
      }

      const randomizedOptions = randomizeOptions(options, normalizedCorrectIndex);

      return {
        id: `ai-${roundIndex}-${index}-${hashString(question.question || "")}`,
        area: cleanText(question.area) || "Source concept",
        type: "ai",
        prompt: cleanText(question.question),
        options: randomizedOptions.map((option, optionIndex) => ({
          id: option.isCorrect ? "answer" : `ai-option-${optionIndex}-${hashString(option.text)}`,
          text: option.text,
        })),
        answerId: "answer",
        explanation: cleanText(question.explanation) || "The correct answer follows directly from the source text.",
        source: cleanText(question.sourceQuote) || "Source text",
        skillTag: cleanText(question.skillTag) || "Comprehension",
        mapTopic: cleanMapTopic(question.mapTopic || question.skillTag || question.area || `Q${index + 1}`),
      };
    });

    if (questions.length !== expectedCount) {
      throw new Error(`The AI did not return exactly ${expectedCount} questions`);
    }

    return {
      coverageSummary: cleanText(payload.coverageSummary || ""),
      modelUsed: cleanText(payload.modelUsed || ""),
      questions,
    };
  }

  function isAppReadyRound(payload) {
    return payload.questions.every((question) => {
      return (
        question &&
        typeof question.prompt === "string" &&
        Array.isArray(question.options) &&
        question.options.every((option) => option && typeof option.text === "string") &&
        typeof question.answerId === "string"
      );
    });
  }

  function validateAppReadyRound(payload, roundIndex) {
    const expectedCount = getExpectedQuestionCount(payload, roundIndex);
    const questions = payload.questions.slice(0, expectedCount).map((question, index) => {
      const options = question.options.slice(0, 5).map((option, optionIndex) => ({
        id: cleanText(option.id) || `ai-option-${optionIndex}-${hashString(option.text)}`,
        text: cleanText(option.text),
      }));
      const answerId = cleanText(question.answerId);
      const answerExists = options.some((option) => option.id === answerId);
      const uniqueCount = uniqueByKey(options.map((option) => option.text), normalizeKey).length;

      if (options.length !== 5 || !answerExists || uniqueCount !== 5) {
        throw new Error("The backend returned an invalid quiz question");
      }

      const answerIndex = options.findIndex((option) => option.id === answerId);
      if (hasNearDuplicateCorrectOption(options.map((option) => option.text), answerIndex)) {
        throw new Error("The backend returned another option too similar to the correct answer");
      }

      const randomizedOptions = randomizeOptions(
        options.map((option) => option.text),
        answerIndex,
      );

      return {
        id: cleanText(question.id) || `ai-${roundIndex}-${index}-${hashString(question.prompt || "")}`,
        area: cleanText(question.area) || "Source concept",
        type: cleanText(question.type) || "ai",
        prompt: cleanText(question.prompt),
        options: randomizedOptions.map((option, optionIndex) => ({
          id: option.isCorrect ? "answer" : `ai-option-${optionIndex}-${hashString(option.text)}`,
          text: option.text,
        })),
        answerId: "answer",
        explanation: cleanText(question.explanation) || "The correct answer follows directly from the source text.",
        source: cleanText(question.source) || "Source text",
        skillTag: cleanText(question.skillTag) || "Comprehension",
        mapTopic: cleanMapTopic(question.mapTopic || question.skillTag || question.area || `Q${index + 1}`),
      };
    });

    if (questions.length !== expectedCount) {
      throw new Error(`The backend did not return exactly ${expectedCount} questions`);
    }

    return {
      coverageSummary: cleanText(payload.coverageSummary || ""),
      modelUsed: cleanText(payload.modelUsed || ""),
      questions,
    };
  }

  function getExpectedQuestionCount(payload, fallback) {
    const explicit = Number(payload?.questionCount || payload?.roundSize);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const fallbackNumber = Number(fallback);
    if (Number.isInteger(fallbackNumber) && fallbackNumber > 0) return fallbackNumber;
    if (Array.isArray(payload?.questions) && payload.questions.length > 0) return payload.questions.length;
    return 5;
  }

  function extractGeminiText(payload) {
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    return parts.map((part) => part.text || "").join("").trim();
  }

  function parseJsonFromText(text) {
    const clean = String(text || "").trim();
    try {
      return JSON.parse(clean);
    } catch (firstError) {
      const unfenced = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      try {
        return JSON.parse(unfenced);
      } catch (secondError) {
        const start = unfenced.indexOf("{");
        const end = unfenced.lastIndexOf("}");
        if (start >= 0 && end > start) {
          return JSON.parse(unfenced.slice(start, end + 1));
        }
        throw firstError;
      }
    }
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function cleanMapTopic(value) {
    const words = cleanText(value).split(/\s+/).filter(Boolean);
    return words.slice(0, 3).join(" ") || "Topic";
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

  function randomizeOptions(options, correctIndex) {
    const decorated = options.map((option, index) => ({
      text: cleanText(option),
      isCorrect: index === correctIndex,
    }));
    return shuffle(decorated);
  }

  function hasNearDuplicateCorrectOption(options, correctIndex) {
    const correct = cleanText(options[correctIndex]);
    return options.some((option, index) => index !== correctIndex && areOptionsTooSimilar(correct, option));
  }

  function areOptionsTooSimilar(first, second) {
    const firstKey = normalizeKey(first);
    const secondKey = normalizeKey(second);
    if (!firstKey || !secondKey) return false;
    if (firstKey === secondKey) return true;
    if (firstKey.length > 25 && secondKey.length > 25 && (firstKey.includes(secondKey) || secondKey.includes(firstKey))) {
      return true;
    }

    const firstTokens = meaningfulTokens(firstKey);
    const secondTokens = meaningfulTokens(secondKey);
    if (firstTokens.length < 4 || secondTokens.length < 4) return false;

    const secondSet = new Set(secondTokens);
    const overlap = firstTokens.filter((token) => secondSet.has(token)).length;
    const union = new Set(firstTokens.concat(secondTokens)).size;
    return overlap / Math.min(firstTokens.length, secondTokens.length) >= 0.86 && overlap / union >= 0.72;
  }

  function meaningfulTokens(key) {
    const stopWords = new Set(["the", "and", "that", "this", "with", "from", "into", "about", "because", "when", "while", "which"]);
    return key.split(/\s+/).filter((token) => token.length > 2 && !stopWords.has(token));
  }

  function shuffle(items) {
    const copy = items.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  }

  function normalizeKey(text) {
    return String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < String(text).length; i += 1) {
      hash ^= String(text).charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  return {
    generateQuiz,
    getConfig,
    verifyAccessCode,
    getAccessCode,
    _private: {
      buildSystemPrompt,
      buildUserPrompt,
      normalizeAiRound,
      extractGeminiText,
      parseJsonFromText,
      getBackendUrl,
      isAppReadyRound,
    },
  };
});
