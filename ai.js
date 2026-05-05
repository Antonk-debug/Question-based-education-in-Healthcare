(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.AiQuizService = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const ACCESS_CODE_KEY = "adaptiveQuizAccessCode";
  const QBL_QUESTION_COUNT = 3;
  const DEFAULT_QBL_COURSE_DESCRIPTION =
    "A short, specialized continuing education course for registered dietitians in Sweden. The course focuses on Personalised Nutrition Care, integrating nutrigenomics, microbiome analysis, and individualized metabolic profiling with Swedish dietary guidelines such as NNR 2023.";
  const DEFAULT_QBL_LEARNING_GOAL =
    "Apply personalised nutrition principles to create individualized dietary interventions while still considering evidence-based Swedish dietary guidelines.";
  const DEFAULT_QBL_SELECTED_SKILL =
    "Analyzing patient continuous glucose monitor, CGM, data alongside subjective lifestyle logs to identify highly individualized glycemic triggers that do not align with standard population-level carbohydrate guidelines.";
  const DEFAULT_QBL_SOURCE_TEXT = [
    "A short, specialized continuing education course for registered dietitians in Sweden. The course focuses on \"Personalised Nutrition Care,\" updating clinical skills to integrate nutrigenomics, microbiome analysis, and individualized metabolic profiling alongside Nordic dietary guidelines (e.g., NNR 2023) to create highly tailored patient interventions.",
    "",
    "Skill context:",
    "Analyzing patient continuous glucose monitor (CGM) data alongside subjective lifestyle logs to identify highly individualized glycemic triggers that do not align with population-level carbohydrate guidelines, interpreted within the patient\u2019s broader metabolic health picture and used to inform, not override, tailored dietary prescriptions.",
  ].join("\n");
  const DEFAULT_QBL_SETUP = Object.freeze({
    courseDescription: DEFAULT_QBL_COURSE_DESCRIPTION,
    learningGoal: DEFAULT_QBL_LEARNING_GOAL,
    selectedSkill: DEFAULT_QBL_SELECTED_SKILL,
    sourceText: DEFAULT_QBL_SOURCE_TEXT,
  });

  async function generateQuiz(options) {
    const settings = Object.assign(
      {
        courseDescription: DEFAULT_QBL_COURSE_DESCRIPTION,
        learningGoal: DEFAULT_QBL_LEARNING_GOAL,
        selectedSkill: DEFAULT_QBL_SELECTED_SKILL,
        text: DEFAULT_QBL_SOURCE_TEXT,
        roundSize: QBL_QUESTION_COUNT,
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

    return normalizeAiRound(payload, settings.roundIndex, settings);
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

  // QBL system prompt is defined here. It sets the learning philosophy, JSON contract, and validation rules Gemini should follow.
  function buildSystemPrompt() {
    return [
      "You are an expert Question-Based Learning designer for professional and continuing education.",
      "Question-Based Learning is for learning through answering questions, not for evaluation. If the learner already knows all answers from the start, there is nothing to learn from the course.",
      "Generate QBL-style learning content for one selected skill at a time.",
      "Use the supplied course description, learning goal, selected skill, and source text as the complete educational context.",
      "Do not assume a dietetics, healthcare, CGM, or nutrition topic unless those details appear in the supplied fields.",
      "Create a short but informative knowledge bank about the selected skill, based mainly on the source text.",
      "Create exactly three multiple-choice QBL questions of varying difficulty: easy, medium, and hard.",
      "Questions must fit the target group and subject area described in the course description.",
      "Questions must encourage understanding, application, or analysis, not simple memorization.",
      "Do not create simple lookup, recall, or definition questions.",
      "Each question must be easy to understand, unambiguous, and focused on one common misconception.",
      "Each question must have exactly four answer options with ids A, B, C, and D.",
      "Every option must be short, clear, plausible, and contextually appropriate.",
      "Each incorrect option must be a realistic distractor tied directly to the targeted misconception.",
      "Every option must include unique tailored feedback.",
      "Feedback for the correct option must begin with exactly 'Correct.'.",
      "Feedback for incorrect options must begin with exactly 'Incorrect.'.",
      "Incorrect feedback must be short, constructive, and guide the learner without revealing, naming, quoting, or describing the correct answer.",
      "Never write 'The correct answer is' or similar wording in incorrect feedback.",
      "Return only valid JSON. Do not wrap it in markdown.",
      "Return this exact JSON shape: {\"course\":\"string\",\"learningGoal\":\"string\",\"skill\":\"string\",\"knowledgeBank\":\"string\",\"questionCount\":3,\"questions\":[{\"difficulty\":\"easy\",\"targetedMisconception\":\"string\",\"question\":\"string\",\"options\":[{\"id\":\"A\",\"text\":\"string\",\"isCorrect\":true,\"feedback\":\"Correct. string\"},{\"id\":\"B\",\"text\":\"string\",\"isCorrect\":false,\"feedback\":\"Incorrect. string\"}]}]}.",
    ].join(" ");
  }

  function getQblContext(settings) {
    const source = settings || {};
    return {
      courseDescription: cleanText(source.courseDescription || source.course || DEFAULT_QBL_COURSE_DESCRIPTION),
      learningGoal: cleanText(source.learningGoal || DEFAULT_QBL_LEARNING_GOAL),
      selectedSkill: cleanText(source.selectedSkill || source.skill || DEFAULT_QBL_SELECTED_SKILL),
      sourceText: cleanText(source.sourceText || source.text || DEFAULT_QBL_SOURCE_TEXT),
    };
  }
  function buildUserPrompt(settings) {
    const qblContext = getQblContext(settings);
    const weakAreas = settings.weakAreas?.length ? settings.weakAreas.join(", ") : "None yet";
    const mistakes = settings.previousMistakes?.length
      ? settings.previousMistakes
          .slice(-8)
          .map((item, index) => `${index + 1}. Area: ${item.area}. Question: ${item.prompt}. Correct: ${item.correct}. Chosen: ${item.chosen || "No answer"}.`)
          .join("\n")
      : "No previous mistakes.";

    return [
      // Course description, learning goal, selected skill, and source text are inserted into the QBL prompt here.
      "Course description:",
      qblContext.courseDescription,
      "Learning goal:",
      qblContext.learningGoal,
      "Selected skill:",
      qblContext.selectedSkill,
      `Round: ${settings.roundIndex || 1}`,
      `Number of QBL questions to generate: ${QBL_QUESTION_COUNT}`,
      `Weak areas from earlier answers: ${weakAreas}`,
      "Previous learner mistakes:",
      mistakes,
      "Source text:",
      qblContext.sourceText,
      "Output language: English unless the course description, learning goal, selected skill, or source text is clearly written in another language. Preserve technical terms, guideline names, and proper nouns from the supplied context.",
      "Generate the QBL knowledge bank and three questions now.",
    ].join("\n\n");
  }
  function normalizeAiRound(payload, roundIndex, context) {
    // The parsed AI JSON response is normalized and validated here before the app renders it.
    const qblContext = getQblContext(context);
    if (!payload || !Array.isArray(payload.questions)) {
      throw new Error("The AI response had the wrong QBL shape");
    }

    if (payload.questions.length !== QBL_QUESTION_COUNT) {
      throw new Error(`The AI must return exactly ${QBL_QUESTION_COUNT} QBL questions`);
    }

    const learningGoal = cleanText(payload.learningGoal) || normalizeStringArray(payload.learningGoals, [qblContext.learningGoal])[0];
    const skill = cleanText(payload.skill) || normalizeStringArray(payload.skills, [qblContext.selectedSkill])[0];
    const questions = payload.questions.map((question, index) => normalizeQblQuestion(question, index, roundIndex, qblContext));

    return {
      course: cleanCourse(payload.course, qblContext.courseDescription),
      learningGoal,
      skill,
      learningGoals: normalizeStringArray(payload.learningGoals || [payload.learningGoal], [learningGoal]),
      skills: normalizeStringArray(payload.skills || [payload.skill], [skill]),
      knowledgeBank: validateKnowledgeBank(payload.knowledgeBank),
      coverageSummary: cleanText(payload.coverageSummary || payload.knowledgeBank || ""),
      questionCount: QBL_QUESTION_COUNT,
      modelUsed: cleanText(payload.modelUsed || ""),
      questions,
    };
  }
  function normalizeQblQuestion(question, index, roundIndex, context) {
    const qblContext = getQblContext(context);
    if (!question || typeof question !== "object") {
      throw new Error(`QBL question ${index + 1} is missing`);
    }

    const prompt = cleanText(question.question || question.prompt);
    if (!prompt) throw new Error(`QBL question ${index + 1} is missing question text`);
    if (isLookupStyleQuestion(prompt)) throw new Error(`QBL question ${index + 1} looks like a lookup or definition question`);

    const rawOptions = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
    if (rawOptions.length < 3) throw new Error(`QBL question ${index + 1} needs at least three answer options`);

    const answerId = cleanText(question.answerId);
    const normalizedOptions = rawOptions.map((option, optionIndex) => normalizeQblOption(option, optionIndex, answerId));
    const optionTexts = normalizedOptions.map((option) => option.text);
    const uniqueCount = uniqueByKey(optionTexts, normalizeKey).length;
    if (uniqueCount !== normalizedOptions.length) throw new Error(`QBL question ${index + 1} has duplicate answer options`);

    const correctOptions = normalizedOptions.filter((option) => option.isCorrect);
    if (correctOptions.length !== 1) throw new Error(`QBL question ${index + 1} must have exactly one correct answer`);

    const correctOption = correctOptions[0];
    const correctIndex = normalizedOptions.findIndex((option) => option.id === correctOption.id);
    if (hasNearDuplicateCorrectOption(optionTexts, correctIndex)) {
      throw new Error(`QBL question ${index + 1} has an answer option too similar to the correct option`);
    }

    normalizedOptions.forEach((option) => validateQblFeedback(option, correctOption.text, index));

    const difficulty = normalizeDifficulty(question.difficulty, index);
    const targetedMisconception = cleanText(question.targetedMisconception);
    if (!targetedMisconception) throw new Error(`QBL question ${index + 1} needs a targeted misconception`);

    return {
      id: cleanText(question.id) || `qbl-${roundIndex || 1}-${index}-${hashString(prompt)}`,
      area: cleanText(question.area) || cleanMapTopic(qblContext.selectedSkill || qblContext.courseDescription),
      type: "qbl",
      prompt,
      options: normalizedOptions,
      answerId: correctOption.id,
      explanation: correctOption.feedback,
      source: "QBL knowledge bank",
      skillTag: cleanText(question.skillTag) || qblContext.selectedSkill,
      mapTopic: cleanMapTopic(question.mapTopic || targetedMisconception || difficulty),
      difficulty,
      targetedMisconception,
    };
  }
  function normalizeQblOption(option, optionIndex, answerId) {
    if (!option || typeof option !== "object") {
      throw new Error("Each QBL answer option must be an object with id, text, isCorrect, and feedback");
    }

    const fallbackId = String.fromCharCode(65 + optionIndex);
    const id = cleanText(option.id) || fallbackId;
    const isCorrect = typeof option.isCorrect === "boolean" ? option.isCorrect : Boolean(answerId && id === answerId);

    return {
      id,
      text: cleanText(option.text),
      isCorrect,
      feedback: cleanText(option.feedback),
    };
  }

  function validateQblFeedback(option, correctText, questionIndex) {
    if (!option.text) throw new Error(`QBL question ${questionIndex + 1} has an empty answer option`);
    if (!option.feedback) throw new Error(`QBL question ${questionIndex + 1} has an answer option without feedback`);

    if (option.isCorrect) {
      if (!/^Correct\./.test(option.feedback)) {
        throw new Error(`Correct feedback in QBL question ${questionIndex + 1} must begin with "Correct."`);
      }
      return;
    }

    if (!/^Incorrect\./.test(option.feedback)) {
      throw new Error(`Incorrect feedback in QBL question ${questionIndex + 1} must begin with "Incorrect."`);
    }
    if (revealsCorrectAnswer(option.feedback, correctText)) {
      throw new Error(`Incorrect feedback in QBL question ${questionIndex + 1} reveals the correct answer`);
    }
  }

  function revealsCorrectAnswer(feedback, correctText) {
    const feedbackKey = normalizeKey(feedback);
    const correctKey = normalizeKey(correctText);
    if (/\b(correct|right) answer\b/.test(feedbackKey) || /\banswer is\b/.test(feedbackKey)) return true;
    return correctKey.length > 12 && feedbackKey.includes(correctKey);
  }

  function isLookupStyleQuestion(questionText) {
    return /^(define\b|which option best defines|which .*definition|how is .*defined|what does .*mean|what is the definition)\b/i.test(cleanText(questionText));
  }

  function normalizeDifficulty(value, index) {
    const difficulty = cleanText(value).toLowerCase();
    if (["easy", "medium", "hard"].includes(difficulty)) return difficulty;
    return ["easy", "medium", "hard"][index] || "medium";
  }

  function validateKnowledgeBank(value) {
    const knowledgeBank = cleanText(value);
    if (!knowledgeBank) throw new Error("The QBL response needs a knowledgeBank");
    return knowledgeBank;
  }

  function cleanCourse(value, fallback) {
    const fallbackCourse = cleanText(fallback) || "QBL activity";
    if (typeof value === "string") return cleanText(value) || fallbackCourse;
    if (value && typeof value === "object") return cleanText(value.title || value.name || value.description) || fallbackCourse;
    return fallbackCourse;
  }

  function normalizeStringArray(value, fallback) {
    if (!Array.isArray(value)) return fallback.slice();
    const items = uniqueByKey(value.map(cleanText).filter(Boolean), normalizeKey);
    return items.length ? items : fallback.slice();
  }

  function isAppReadyRound(payload) {
    return Boolean(
      payload &&
        Array.isArray(payload.questions) &&
        payload.questions.every(
          (question) =>
            question &&
            typeof question.prompt === "string" &&
            Array.isArray(question.options) &&
            question.options.every((option) => option && typeof option.text === "string") &&
            typeof question.answerId === "string",
        ),
    );
  }

  function getDefaultQblSourceText() {
    return DEFAULT_QBL_SOURCE_TEXT;
  }

  function getDefaultQblSetup() {
    return Object.assign({}, DEFAULT_QBL_SETUP);
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
    getDefaultQblSourceText,
    getDefaultQblSetup,
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
